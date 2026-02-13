function chartInversed() {
  // ============================
// 📊 CHART
// ============================
  const chart = LightweightCharts.createChart(
      document.getElementById("chart-inversed"),
      {
        layout: {
          background: { color: "#000000" },
          textColor: "#00284e",
        },
        timeScale: { timeVisible: true, secondsVisible: true },
      }
  );

  const series = chart.addSeries(LightweightCharts.CandlestickSeries, {
    priceFormat: {
      type: 'price',
      precision: 4,
      minMove: 0.0001,
    },
  });

  let binanceAsk = null;
  let edgexBid = null;

  let currentCandle = null;
  const candleInterval = 1000;

// ============================
// 📈 Candle Logic
// ============================
  function updateCandle(ratio) {
    if (!Number.isFinite(ratio)) return;

    const now = Date.now();
    const bucket = Math.floor(now / candleInterval) * candleInterval;

    if (!currentCandle || currentCandle.time !== bucket / 1000) {
      currentCandle = {
        time: bucket / 1000,
        open: ratio,
        high: ratio,
        low: ratio,
        close: ratio,
      };
      series.update(currentCandle);
    } else {
      currentCandle.high = Math.max(currentCandle.high, ratio);
      currentCandle.low = Math.min(currentCandle.low, ratio);
      currentCandle.close = ratio;
      series.update(currentCandle);
    }
  }

  const edgexMultiplier = 50/0.9523;

  function tryUpdate() {
    if (binanceAsk !== null && edgexBid !== null) {
      document.getElementById('b-ask').textContent = binanceAsk;
      document.getElementById('e-bid').textContent = edgexBid;

      const ratio = binanceAsk / (edgexBid * edgexMultiplier);
      updateCandle(ratio);
    }
  }

// ============================
// 🔵 BINANCE FUTURES
// ============================
  const binanceWs = new WebSocket(
      "wss://fstream.binance.com/ws/paxgusdt@bookTicker"
  );

  binanceWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log('bn message', msg)
    binanceAsk = parseFloat(msg.a); // 🔥 best ask
    tryUpdate();
  };

  binanceWs.onerror = (err) => {
    console.error("Binance WS error", err);
  };

// ============================
// 🔴 EDGEX PUBLIC WS
// ============================
  const contractId = "10000245";

  const edgexWs = new WebSocket(
      "wss://quote.edgex.exchange/api/v1/public/ws"
  );

  edgexWs.onopen = () => {
    edgexWs.send(
        JSON.stringify({
          type: "subscribe",
          channel: `depth.${contractId}.15`,
        })
    );
  };

  edgexWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // heartbeat
    if (msg.type === "ping") {
      edgexWs.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (!msg?.content?.data) return;

    console.log(msg);

    if (
        msg.content.dataType === "Snapshot" ||
        msg.content.dataType === "changed"
    ) {
      const bids = msg.content.data[0].bids;

      if (Array.isArray(bids) && bids.length > 0) {
        edgexBid = parseFloat(bids[0].price); // 🔥 best bid
        tryUpdate();
      }
    }
  };

  edgexWs.onerror = (err) => {
    console.error("EdgeX WS error", err);
  };

}