
function chart() {
  // ============================
  // 📊 CHART
  // ============================
  const chart = LightweightCharts.createChart(
      document.getElementById("chart"),
      {
        layout: {
          background: {color: "#00284e"},
          textColor: "#9a8000",
        },
        timeScale: {timeVisible: true, secondsVisible: true},
      }
  );

  const series = chart.addSeries(LightweightCharts.CandlestickSeries);

  let binanceBid = null;
  let edgexAsk = null;

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
    if (binanceBid !== null && edgexAsk !== null) {
      document.getElementById('b-bid').textContent = binanceBid;
      document.getElementById('e-ask').textContent = edgexAsk;

      const adjustedBinance = binanceBid;
      const adjustedEdgex = edgexAsk * edgexMultiplier;

      const ratio = adjustedBinance / adjustedEdgex;

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
    binanceBid = parseFloat(msg.b); // best bid
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

    console.log('edgex message', msg)

    // EdgeX heartbeat
    if (msg.type === "ping") {
      edgexWs.send(JSON.stringify({type: "pong"}));
      return;
    }

    if (!msg?.content?.data) return;

    // Snapshot або Changed
    if (
        msg.content.dataType === "Snapshot" ||
        msg.content.dataType === "changed"
    ) {
      const asks = msg.content.data[0].asks;

      if (Array.isArray(asks) && asks.length > 0) {
        edgexAsk = parseFloat(asks[0].price); // best ask
        console.log('update triggered by edgex', edgexAsk)

        tryUpdate();
      }
    }
  };

  edgexWs.onerror = (err) => {
    console.error("EdgeX WS error", err);
  };
}