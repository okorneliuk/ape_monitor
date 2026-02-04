// 🟦 Створюємо графік
const chart = LightweightCharts.createChart(document.getElementById('chart'), {
  layout: {
    background: { color: '#0f172a' },
    textColor: '#cbd5e1',
  },
  grid: {
    vertLines: { color: '#1e293b' },
    horzLines: { color: '#1e293b' },
  },
  timeScale: { timeVisible: true, secondsVisible: true },
});

// В v5 замість chart.addCandlestickSeries() робимо:
const candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
  upColor: '#26a69a',
  downColor: '#ef5350',
  borderVisible: false,
});

// 📈 Дані для розрахунку
let krakenBid = null;
let coinbaseAsk = null;

let currentCandle = null;
const candleInterval = 1000; // 1 сек

// 🔁 Функція оновлення свічки
function updateCandle(ratio) {
  const nowMs = Date.now();
  const bucketTime = Math.floor(nowMs / candleInterval) * candleInterval;

  if (!currentCandle || currentCandle.time !== bucketTime / 1000) {
    currentCandle = {
      time: bucketTime / 1000,
      open: ratio,
      high: ratio,
      low: ratio,
      close: ratio,
    };
    candleSeries.update(currentCandle);
  } else {
    currentCandle.high = Math.max(currentCandle.high, ratio);
    currentCandle.low = Math.min(currentCandle.low, ratio);
    currentCandle.close = ratio;
    candleSeries.update(currentCandle);
  }
}

// 🔄 Спроба оновити, якщо обидва значення готові
function tryUpdate() {
  if (krakenBid !== null && coinbaseAsk !== null) {
    const ratio = krakenBid / coinbaseAsk;
    updateCandle(ratio);
  }
}

//
// 📌 Kraken WS (best bid of APE/USDT)
//
const krakenWs = new WebSocket('wss://ws.kraken.com/v2');

krakenWs.onopen = () => {
  krakenWs.send(JSON.stringify({
    method: 'subscribe',
    params: {
      channel: 'book',
      symbol: ['APE/USDT'],
      depth: 10,
    },
  }));
};

krakenWs.onmessage = (event) => {

  const msg = JSON.parse(event.data);

  console.log('kk message', msg)

  if (msg.channel === 'book' && msg.data?.[0]?.bids?.[0]) {
    krakenBid = parseFloat(msg.data[0].bids[0].price);
    console.log('kk update triggered')
    tryUpdate();
  }
};

//
// 📌 Coinbase WS (best ask of APE/USDC futures)
//
const coinbaseWs = new WebSocket('wss://advanced-trade-ws.coinbase.com');

coinbaseWs.onopen = () => {
  coinbaseWs.send(JSON.stringify({
    type: "subscribe",
    product_ids: ["APE-USDC"],
    channel: "level2",
  }));
};

coinbaseWs.onmessage = (event) => {
  const msg = JSON.parse(event.data).events[0];

  console.log('cb message', msg)

  if (msg.type === 'snapshot' && msg.asks?.length > 0) {
    coinbaseAsk = parseFloat(msg.asks[0][0]);
    console.log('cb update triggered by snapshot')
    tryUpdate();
  }

  if (msg.type === 'update') {
    console.log(msg.updates);
    for (const {side, price_level} of msg.updates) {
      if (side === 'bid') {
        coinbaseAsk = parseFloat(price_level);
        console.log('cb update triggered by update')
        tryUpdate();
        break;
      }
    }
  }
};

