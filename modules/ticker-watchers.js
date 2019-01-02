const stocks = require('../stocks');
const allStocks = require('../json/stock-data/allStocks');
const HistoricalTickerWatcher = require('../socket-server/historical-ticker-watcher');
const { lookupTickers } = require('../app-actions/record-strat-perfs');
const getTrend = require('../utils/get-trend');
const { isTradeable } = require('../utils/filter-by-tradeable');
const { avgArray } = require('../utils/array-math');
const sendEmail = require('../utils/send-email');
const regCronIncAfterSixThirty = require('../utils/reg-cron-after-630');
const recordPicks = require('../app-actions/record-picks');
const addOvernightJumpAndTSO = require('../app-actions/add-overnight-jump-and-tso');
const getTrendSinceOpen = require('../rh-actions/get-trend-since-open');

let tickerWatcher;
let bigJumps = [];
let relatedP;

const onEnd = () => {
    console.log();
    bigJumps = bigJumps
        .map(jump => ({
            ...jump,
            finalPrice: relatedP[jump.ticker].pop().lastTradePrice
        }))
        .map(jump => ({
            ...jump,
            trend: getTrend(jump.finalPrice, jump.jumpPrice)
        }))
        .sort((a, b) => b.trendFromMin - a.trendFromMin);
    
    console.log('HERE');
    console.log(JSON.stringify(bigJumps, null ,2))


    const avgTrend = avgArray(bigJumps.map(j => j.trend));
    console.log({ avgTrend });
    bigJumps.forEach(jump => console.log(jump));
};



module.exports = {
    name: 'ticker-watchers',
    init: async (Robinhood) => {

        // setTimeout(async () => {
        //     console.log('recording based-on-jump-fourToEightOvernight-trending35257-gt500kvolume-first2-5');
        //     await recordPicks(Robinhood, 'based-on-jump-fourToEightOvernight-trending35257-gt500kvolume-first2', 5, ['BPMX']);
        // }, 10000);

        const handler = async relatedPrices => {
            // console.log({ relatedPrices, two });
            relatedP = relatedPrices;
            const newJumps = [];
            Object.keys(relatedPrices).forEach(key => {
                const allPrices = relatedPrices[key].map(obj => obj.lastTradePrice);
                const mostRecent = allPrices.pop();
                const min = Math.min(...allPrices);
                const trendFromMin = getTrend(mostRecent, min);
                const bigJump = trendFromMin < -10;
                // console.log({ min, trendFromMin })
                if (bigJump && allPrices.length >= 3) {
                    console.log('found big jump', key, mostRecent, allPrices);
                    newJumps.push({
                        ticker: key,
                        jumpPrice: mostRecent,
                        trendFromMin
                    });
                }
            });

            bigJumps = [...bigJumps, ...newJumps];

            return newJumps;

        };
        
        tickerWatcher = new HistoricalTickerWatcher({
            name: 'ticker-watchers',
            Robinhood,
            handler,
            timeout: 60000 * 5, // 5 min,
            runAgainstPastData: false,
            onPick: async pick => {
                await sendEmail(`robinhood-playground: NEW JUMP DOWN ${pick.ticker}`, JSON.stringify(pick, null, 2));
                await recordPicks(Robinhood, 'ticker-watchers-under5', 5000, [pick.ticker]);
            },
            onEnd
        });

        const allUnder15 = await (async () => {
            const tickPrices = await lookupTickers(Robinhood, allStocks.filter(isTradeable).map(o => o.symbol));
            return Object.keys(tickPrices).filter(ticker => tickPrices[ticker] < 15 && tickPrices[ticker] > 1);
        })();
        console.log({ allUnder15 });

        regCronIncAfterSixThirty(Robinhood, {
            name: `clear ticker-watchers price cache`,
            run: [0],
            fn: () => tickerWatcher.clearPriceCache()
        });

        const setTickers = async () => {
            // all under $15 and no big overnight jumps
            tickerWatcher.clearTickers();
            tickerWatcher.addTickers(allUnder15);
            const trend = await getTrendSinceOpen(Robinhood, allUnder15);
            const withOvernightJumps = await addOvernightJumpAndTSO(Robinhood, trend);
            const bigOvernightJumps = withOvernightJumps
                .filter(o => o.overnightJump > 7)
                .map(t => t.ticker);
            tickerWatcher.removeTickers(bigOvernightJumps);
            // console.log(JSON.stringify({ bigOvernightJumps }, null, 2));
        };

        regCronIncAfterSixThirty(Robinhood, {
            name: `set ticker-watchers tickers (< $15 and no overnight jumps)`,
            run: [2],
            fn: setTickers
        });

        regCronIncAfterSixThirty(Robinhood, {
            name: `stop ticker-watchers`,
            run: [330],
            fn: () => tickerWatcher.stop()
        });

        await setTickers();
        tickerWatcher.start();

    }
};