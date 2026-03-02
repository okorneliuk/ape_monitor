(function () {
  const qs = new URLSearchParams(window.location.search);

  const configEl = document.getElementById("config");
  const pricesEl = document.getElementById("prices");

  const left = {
    exchange: readRequired("ex1"),
    pair: readRequired("pair1"),
    side: readSide("side1", "bid"),
  };
  const right = {
    exchange: readRequired("ex2"),
    pair: readRequired("pair2"),
    side: readSide("side2", "ask"),
  };

  const ratio = parseRatio(qs.get("ratio") || "1:1");
  const candleInterval = parsePositiveInt(qs.get("intervalMs"), 1000);

  const chart = LightweightCharts.createChart(document.getElementById("chart"), {
    layout: {
      background: { color: "#0f172a" },
      textColor: "#cbd5e1",
    },
    grid: {
      vertLines: { color: "#1e293b" },
      horzLines: { color: "#1e293b" },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: true,
    },
  });

  const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderVisible: false,
  });

  window.addEventListener("resize", () => {
    chart.resize(window.innerWidth, window.innerHeight - 64);
  });

  configEl.textContent =
    `${left.exchange}:${left.pair}(${left.side}) / ` +
    `${right.exchange}:${right.pair}(${right.side})` +
    ` | ratio ${ratio.left}:${ratio.right}`;

  let leftPrice = null;
  let rightPrice = null;
  let currentCandle = null;

  function tryUpdate() {
    pricesEl.textContent =
      `left=${formatNum(leftPrice)} | right=${formatNum(rightPrice)}`;

    if (!Number.isFinite(leftPrice) || !Number.isFinite(rightPrice)) {
      return;
    }

    const result = (leftPrice * ratio.left) / (rightPrice * ratio.right);
    updateCandle(result);
  }

  function updateCandle(value) {
    if (!Number.isFinite(value)) return;

    const now = Date.now();
    const bucket = Math.floor(now / candleInterval) * candleInterval;
    const time = bucket / 1000;

    if (!currentCandle || currentCandle.time !== time) {
      currentCandle = {
        time,
        open: value,
        high: value,
        low: value,
        close: value,
      };
    } else {
      currentCandle.high = Math.max(currentCandle.high, value);
      currentCandle.low = Math.min(currentCandle.low, value);
      currentCandle.close = value;
    }

    series.update(currentCandle);
  }

  connectSource(left, (value) => {
    leftPrice = value;
    tryUpdate();
  });

  connectSource(right, (value) => {
    rightPrice = value;
    tryUpdate();
  });

  function connectSource(source, onPrice) {
    const exchange = source.exchange.toLowerCase();

    if (exchange === "kraken") {
      connectKraken(source, onPrice);
      return;
    }

    if (exchange === "coinbase") {
      connectCoinbase(source, onPrice);
      return;
    }

    if (exchange === "binance") {
      connectBinance(source, onPrice);
      return;
    }

    if (exchange === "edgex") {
      connectEdgex(source, onPrice);
      return;
    }

    fail(`Unsupported exchange: ${source.exchange}`);
  }

  function connectKraken(source, onPrice) {
    const ws = new WebSocket("wss://ws.kraken.com/v2");
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          method: "subscribe",
          params: {
            channel: "book",
            symbol: [source.pair],
            depth: 10,
          },
        })
      );
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      const book = msg?.data?.[0];
      const levels = source.side === "bid" ? book?.bids : book?.asks;
      const px = levels?.[0]?.price;
      const parsed = Number.parseFloat(px);
      if (Number.isFinite(parsed)) onPrice(parsed);
    };

    ws.onerror = () => fail(`WS error from Kraken (${source.pair})`);
  }

  function connectCoinbase(source, onPrice) {
    let hasPrice = false;
    let fallbackStarted = false;

    const markAndEmit = (value) => {
      hasPrice = true;
      onPrice(value);
    };

    const advancedWs = new WebSocket("wss://advanced-trade-ws.coinbase.com");

    const fallbackTimer = setTimeout(() => {
      if (hasPrice || fallbackStarted) return;
      fallbackStarted = true;
      try {
        advancedWs.close();
      } catch {
        // no-op
      }
      connectCoinbaseLegacy(source, markAndEmit);
    }, 6000);

    advancedWs.onopen = () => {
      advancedWs.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [source.pair],
          channel: "level2",
        })
      );
    };

    advancedWs.onmessage = (event) => {
      let root;
      try {
        root = JSON.parse(event.data);
      } catch {
        return;
      }

      const events = Array.isArray(root?.events) ? root.events : [];

      for (const ev of events) {
        if (ev.type === "snapshot") {
          const parsed = pickCoinbaseSnapshotPrice(ev, source.side);
          if (Number.isFinite(parsed)) markAndEmit(parsed);
        }

        if (ev.type === "update" && Array.isArray(ev.updates)) {
          for (const u of ev.updates) {
            const updateSide = normalizeCoinbaseSide(u.side);
            if (!updateSide || updateSide !== source.side) continue;
            const parsed = Number.parseFloat(u.price_level);
            if (Number.isFinite(parsed)) {
              markAndEmit(parsed);
              break;
            }
          }
        }
      }
    };

    advancedWs.onerror = () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      clearTimeout(fallbackTimer);
      connectCoinbaseLegacy(source, markAndEmit);
    };

    advancedWs.onclose = () => {
      if (hasPrice || fallbackStarted) return;
      fallbackStarted = true;
      clearTimeout(fallbackTimer);
      connectCoinbaseLegacy(source, markAndEmit);
    };
  }

  function connectCoinbaseLegacy(source, onPrice) {
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [source.pair],
          channels: ["ticker"],
        })
      );
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg?.type !== "ticker") return;
      const raw = source.side === "bid" ? msg.best_bid : msg.best_ask;
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) onPrice(parsed);
    };

    ws.onerror = () => fail(`WS error from Coinbase (${source.pair})`);
  }

  function pickCoinbaseSnapshotPrice(event, side) {
    const directLevels = side === "bid" ? event.bids : event.asks;
    if (Array.isArray(directLevels) && directLevels.length > 0) {
      const first = directLevels[0];
      if (Array.isArray(first)) {
        const parsed = Number.parseFloat(first[0]);
        if (Number.isFinite(parsed)) return parsed;
      }
      if (typeof first === "object" && first !== null) {
        const parsed = Number.parseFloat(first.price_level ?? first.price);
        if (Number.isFinite(parsed)) return parsed;
      }
    }

    if (!Array.isArray(event.updates)) return null;

    let best = null;
    for (const u of event.updates) {
      const updateSide = normalizeCoinbaseSide(u.side);
      if (!updateSide || updateSide !== side) continue;
      const px = Number.parseFloat(u.price_level ?? u.price);
      if (!Number.isFinite(px)) continue;
      if (best === null) {
        best = px;
        continue;
      }
      best = side === "bid" ? Math.max(best, px) : Math.min(best, px);
    }
    return best;
  }

  function normalizeCoinbaseSide(raw) {
    const side = String(raw || "").toLowerCase();
    if (side === "bid") return "bid";
    if (side === "ask" || side === "offer") return "ask";
    return null;
  }

  function connectBinance(source, onPrice) {
    const symbol = normalizeBinancePair(source.pair).toLowerCase();
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol}@bookTicker`);

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      const px = source.side === "bid" ? msg?.b : msg?.a;
      const parsed = Number.parseFloat(px);
      if (Number.isFinite(parsed)) onPrice(parsed);
    };

    ws.onerror = () => fail(`WS error from Binance (${source.pair})`);
  }

  function normalizeBinancePair(input) {
    return String(input || "")
      .trim()
      .toUpperCase()
      .replace(/[\/\-_:\s]+/g, "");
  }

  function connectEdgex(source, onPrice) {
    const contractId = normalizeEdgeXPair(source.pair);
    const ws = new WebSocket("wss://quote.edgex.exchange/api/v1/public/ws");

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "subscribe",
          channel: `depth.${contractId}.15`,
        })
      );
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      const data = msg?.content?.data?.[0];
      if (!data) return;

      const levels = source.side === "bid" ? data.bids : data.asks;
      const px = Array.isArray(levels) && levels[0] ? levels[0].price : null;
      const parsed = Number.parseFloat(px);
      if (Number.isFinite(parsed)) onPrice(parsed);
    };

    ws.onerror = () => fail(`WS error from EdgeX (${source.pair})`);
  }

  function normalizeEdgeXPair(input) {
    if (/^\d+$/.test(input)) return input;

    const known = {
      PAXGUSDT: "10000245",
    };

    const mapped = known[input.toUpperCase()];
    if (mapped) return mapped;

    fail(`Unknown EdgeX pair '${input}'. Use contract id (example: 10000245).`);
  }

  function readRequired(key) {
    const value = qs.get(key);
    if (!value) fail(`Missing query param: ${key}`);
    return value;
  }

  function readSide(key, fallback) {
    const raw = (qs.get(key) || fallback).toLowerCase();
    if (raw !== "bid" && raw !== "ask") {
      fail(`Invalid ${key}: '${raw}'. Use bid or ask.`);
    }
    return raw;
  }

  function parseRatio(raw) {
    const normalized = raw.trim();
    const parts = normalized.includes(":")
      ? normalized.split(":")
      : normalized.split("/");

    if (parts.length !== 2) {
      fail(`Invalid ratio '${raw}'. Use format like 1:1 or 0.9523:50.`);
    }

    const leftValue = Number.parseFloat(parts[0]);
    const rightValue = Number.parseFloat(parts[1]);

    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue) || rightValue === 0) {
      fail(`Invalid ratio '${raw}'.`);
    }

    return { left: leftValue, right: rightValue };
  }

  function parsePositiveInt(value, fallback) {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  function formatNum(value) {
    return Number.isFinite(value) ? value : "-";
  }

  function fail(message) {
    configEl.textContent = "Configuration error";
    pricesEl.textContent = message;
    pricesEl.classList.remove("muted");
    pricesEl.classList.add("error");
    throw new Error(message);
  }
})();
