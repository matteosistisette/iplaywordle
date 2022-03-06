require('dotenv').config();
const pup = require('puppeteer-core');
const fs = require('fs');
const TwitterApi = require('twitter-api-v2').default;
const sleep = ms => new Promise(r => setTimeout(r, ms));

var nScreenshot = 0;
var shareText = "";

const awaitTimeout = (delay, reason) =>
    new Promise((resolve, reject) =>
        setTimeout(
            () => (reason === undefined ? resolve() : reject(reason)),
            delay
        )
    );

const wrapPromise = (promise, delay, reason) =>
    Promise.race([promise, awaitTimeout(delay, reason)]);


(async function () {

    let done = false;
    for (let i = 1; i <= 3; i++) {
        await console.log("==================== ATTEMPT " + i + " ====================");
        try {
            await main();
            done = true;
            break;
        } catch (e) {
            await console.log("!!!!! Failed with ERROR: ", e);
            await console.log("Sleeping for 1 second before I try again...");
            await sleep(1000);
        }
    }
    if (done) {
        console.log("==========");
        console.log("=  DONE  =");
        console.log("==========");
    }
    else {
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!");
        console.log("!! FAILED PERMANENTLY !!");
        console.log("!!!!!!!!!!!!!!!!!!!!!!!!");
    }
})();


async function main() {

    var words = getAsciiWords(fs.readFileSync('words.txt', 'utf8'));
    var iii = words.indexOf('');
    if (iii >= 0) throw("The dictionary contains the empty string at position " + iii + " of " + words.length + "!!!!!");

    var state = {
        words: words,
        discarded: {}
    };

    await console.log("Connecting with Puppeteer...");
    const browser = await pup.connect({browserWSEndpoint: process.env.BROWSER_ENDPOINT});

    await console.log("Puppeteer connected. Opening new page...");
    const page = await browser.newPage();

    await console.log("New page opened. Setting time zone...");
    await page.emulateTimezone('Europe/Madrid');

    page.on('console', async (msg) => {
        const msgArgs = msg.args();
        for (let i = 0; i < msgArgs.length; ++i) {
            await console.log(await msgArgs[i].jsonValue());
        }
    });

    await console.log("Setting JS code to evaluate on new document...");
    await page.evaluateOnNewDocument(function() {
        navigator.clipboard.writeText = function(text) {
            return new Promise(function(resolve, reject) {
                if (window.emulateWriteToClipboard) {
                    return window.emulateWriteToClipboard(text).then(resolve, reject);
                }
            });
        }
    });

    var URL = 'https://www.nytimes.com/games/wordle/index.html';
    if (process.env.WORDLE_URL !== undefined) URL = process.env.WORDLE_URL;


    await console.log("All ready. Requesting URL '"+URL+"'");
    await page.goto(URL, {timeout: 10000});


    await console.log("Navigated to URL. Exposing functions...");

    var exposeFunctions = async function() {
        await page.exposeFunction('getNextWord', async (g) => {
            return await getNextWord(g, state);
        });
        await page.exposeFunction('logOutside', async (...fargs) => {
            await console.log(...fargs);
        });
        await page.exposeFunction('saveScreenshotOutside', async () => {
            await saveScreenshot(page, true);
        });
        await page.exposeFunction('emulateWriteToClipboard', (text) => {
            shareText = text;
        });
    }

    try {
        await wrapPromise(
            exposeFunctions(),
            10000,
            "Timeout waiting for exposeFunction()"
        );
    } catch (e) {
        browser.close();
        throw e;
    }

    await saveScreenshot(page);

    try {
        await console.log("Waiting for gdpr close button...");
        await page.waitForSelector("#pz-gdpr-btn-closex", {timeout: 2000});
        await console.log("Clicking to close gdpr notice...");
        await page.click("#pz-gdpr-btn-closex");
        await saveScreenshot(page);
    }
    catch (e) {
        await console.log("Seems like there is no gdpr notice.");
    }

    await console.log("Waiting to click on body...");
    await page.click("body");
    await saveScreenshot(page);

    await console.log("Evaluating code in page context...")
    let info = await page.evaluate(async () => {

        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const waitUntilCanInput = async function (game) {
            await logOutside("__ [waiting for canInput...]");
            for (let i = 0; i < 50; i++) {
                if (game.canInput) return true;
                await sleep(100);
            }
            throw "Couldn't input in more than 5 seconds!";
        }

        let g = document.querySelectorAll("game-app")[0];
        let info = {};
        info.solution = g.solution;

        await logOutside("__ Solution is '" + g.solution + "'");
        var word;
        var i = 0;

        while (word = await getNextWord(g)) {

            await waitUntilCanInput(g);
            await logOutside("__ Gonna try word: " + word);
            var letters = word.split("");
            for (var j = 0; j < letters.length; j++) {
                g.addLetter(letters[j]);
            }
            g.evaluateRow();
            await waitUntilCanInput(g);
            await saveScreenshotOutside();
            //await logOutside("Can I input?", g.canInput);
            if (!g.evaluations[i]) {
                await logOutside("__ Rejected. Deleting...");
                for (var j = 0; j < letters.length; j++) g.removeLetter();
            } else {
                if (g.gameStatus == 'WIN') {
                    info.won = true;
                    await logOutside("__ I won!");

                    break;
                }

                await logOutside("__ Nope, wasn't '" + word + "'.")
                i++;
            }
        }
        if (!info.won) {
            await logOutside("__ I lost!");
        }

        if (!info.won && !g.evaluations[g.evaluations.length - 1]) throw "I'm stuck!";

        logOutside("__ Sleeping 5 seconds...");
        await sleep(5000);

        return info;
    });

    await saveScreenshot(page);

    // const shareButton = await page.evaluateHandle(
    //     `document.querySelector("game-app").shadowRoot.querySelector("game-stats").shadowRoot.querySelector("#share-button")`
    // );
    // await shareButton.click();

    await console.log("Clicking on Share button...");
    await page.click('pierce/#share-button');

    await console.log("Shared text:\n"+shareText);

    await sleep(10);
    await saveScreenshot(page);

    browser.close();

    fs.writeFile('output.txt', shareText+"\n", function (err) {
        if (err) console.log("ERROR writing file with shared text", err); else console.log("Saved shared text");
    });

    await console.log("Sharing on Facebook...")
    await shareOnFacebook(info);
    await shareOnTwitter(info);

    //console.log(info);
}

async function saveScreenshot(page, fromInside) {
    nScreenshot++;
    if (fromInside === undefined) fromInside = false;

    var logtext = "Taking screenshot (" + nScreenshot + ")...";
    if (fromInside) logtext = "__ [" + logtext + "]";

    await console.log(logtext);
    const sshot = await page.screenshot();

    fs.writeFile('screenshots/'+nScreenshot+'.png', sshot, function (err) {
        if (err) console.log("ERROR saving screenshot to file", err); //else console.log("Screenshot " + nScreenshot + " saved");
    });
}

async function getNextWord(game, state) {
    try {

        if (game.evaluations[game.evaluations.length - 1] !== null) {
            await console.log("getNextWord() returning false because all " + game.evaluations.length + " evaluations are full.");
            return false;
        }
        var word = await getNextPotentialWord(state);
        if (!word) {
            await console.log("getNextWord() returning false because I'm out of words!");
            return false;
        }
        while (! await isValidCandidate(word, game)) {
            //console.log("Discarding word "+word);
            state.discarded[word] = true;
            word = await getNextPotentialWord(state);
            if (!word) {
                await console.log("Couldn't find a candidate for the next word!");
                if (typeof (word) === 'string') console.log("Word is '" + word + "'. WTF?!?!?");
                break;
            }
        }
        return word;

    } catch (e) {
        await console.log(e);
        return false;
    }
}

async function isValidCandidate(word, game) {
    var wordLetters = word.split("");
    var wordLettersFlipped = {};
    for (var i = 0; i < wordLetters.length; i++) {
        var letter = wordLetters[i];
        if (wordLettersFlipped[letter] === undefined) wordLettersFlipped[letter] = [];
        wordLettersFlipped[letter].push(i);
    }
    var debug = false;
    /*if (word == 'choke') {
        debug = true;
        await console.log("Checking word "+word+". Board state: ", game.boardState);
    }*/
    for (i = 0; i < game.boardState.length; i++) {
        if (!game.boardState[i]) break;
        if (!game.evaluations[i]) break;
        var rowLetters = game.boardState[i].split("");
        var rowLettersFlipped = {};
        for (var j = 0; j < rowLetters.length; j++) {
            letter = rowLetters[j];
            if (rowLettersFlipped[letter] === undefined) {
                rowLettersFlipped[letter] = {'correct': [], 'present': [], 'absent': []};
            }
            rowLettersFlipped[letter][game.evaluations[i][j]].push(j);

        }
        for (var iletter in rowLettersFlipped) {
            for (var ci = 0; ci < rowLettersFlipped[iletter].correct.length; ci++) {
                var position = rowLettersFlipped[iletter].correct[ci];
                if (wordLetters[position] !== iletter) {
                    if (debug) await console.log("Has a '" + wordLetters[position] + "' instead of a '" + iletter + "'at position " + position);
                    return false;
                }
            }
            for (ci = 0; ci < rowLettersFlipped[iletter].present.length; ci++) {
                position = rowLettersFlipped[iletter].present[ci];
                if (wordLetters[position] == iletter) {
                    if (debug) await console.log("Has a '" + iletter + "' at wrong position " + position);
                    return false;
                }
            }
            var mincount = rowLettersFlipped[iletter].correct.length + rowLettersFlipped[iletter].present.length,
                maxcount = rowLetters.length,
                usedcount = 0;
            if (rowLettersFlipped[iletter].absent.length > 0) maxcount = mincount;
            if (wordLettersFlipped[iletter] !== undefined) {
                usedcount = wordLettersFlipped[iletter].length;
            }
            if (usedcount < mincount || usedcount > maxcount) {
                if (debug) await console.log("'" + iletter + "' is used " + usedcount + " times, should be between " + mincount + " and " + maxcount, rowLettersFlipped, game.evaluations);
                return false;
            }

        }
    }
    return true;
}

async function getNextPotentialWord(state) {
    if (state.words.length == 0) {
        await console.log("I'm out of potential words!");
        return false;
    }
    state.currentIndex = getNextIndex(state);
    let word = state.words.splice(state.currentIndex, 1)[0];
    state.currentIndex = state.currentIndex % state.words.length;
    if (word === false) {
        await console.log("getNextPotentialWord() is returning false even though we have words!", state);
    }
    return word;
}

function getNextIndex(state) {
    if (state.words.length == 1) return 0;
    if (state.currentIndex === undefined) state.currentIndex = getStartingIndex(state);
    if (state.offset === undefined) state.offset = 0;
    state.offset = 1 - state.offset;
    return (state.currentIndex + Math.floor((state.words.length - 1) * (0.5 + state.offset * 0.25))) % state.words.length;
}

function getStartingIndex(state) {
    var ndays = Math.round(((new Date()).setHours(0, 0, 0, 0) - (new Date('2021-12-31')).setHours(0, 0, 0, 0)) / 3600 / 24 / 1000);
    //console.log("Getting index for first word. "+ndays+" days" );
    return ndays % state.words.length;
}

function getAsciiWords(text) {
    return text.split(/[\r\n]+/).map(function (word) {
        return word.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    });
}

function getSocialPostText(info, short) {
    if (short === undefined) short = false;

    var text = shareText;
    text += "\n\n" + (new Date()).toString()+"\n";
    if (!short) {
        text += "\n *** SPOILER ALERT\n";
        text += "\n *** SOLUTION BELOW\n";
        text += "\n *** Scroll with caution...\n";
    }
    else {
        //text += "\n * SPOILER ALERT - SOLUTION BELOW *\n";
    }

    if (!short) {
        for (var i = 0; i < (short ? 50 : 100); i++) text += ".\n";
        text += "Solution was: '" + info.solution + "'\n";
        for (var i = 0; i < (short ? 50 : 100); i++) text += ".\n";
    }


    if (!short) {
        text += "\n *** Scroll with caution...\n";
        text += "\n *** SOLUTION ABOVE\n";
        text += "\n *** SPOILER ALERT\n";
    }
    else {
        //text += "\n * SPOILER ALERT - SOLUTION ABOVE *\n";
    }


    return text;
}

async function shareOnFacebook(info) {
    //await console.log("WARNING: not posting on facebook because I don't want to!");
    //return;

    const axios = require('axios');
    const FormData = require('form-data');

    let text = getSocialPostText(info);

    const data = new FormData();
    data.append('message', text);
    data.append('access_token', process.env.FACEBOOK_ACCESS_TOKEN);

    await console.log("Publishing on Facebook...")

    const res = await axios.post(
        'https://graph.facebook.com/' + process.env.FACEBOOK_PAGE_ID+ '/feed',
        data,
        {headers: data.getHeaders()}
    );

    await console.log("Posted on Facebook.", res.data);
}

async function shareOnTwitter(info) {
    try {
        const twitterClient = new TwitterApi({
            appKey: process.env.TWITTER_API_KEY,
            appSecret: process.env.TWITTER_API_SECRET,
            accessToken: process.env.TWITTER_ACCESS_TOKEN,
            accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET
        });

        var xxx = await twitterClient.v1.tweet(getSocialPostText(info, true));

        console.log("Posted on Twitter", xxx);
    } catch (e) {
        console.log("ERROR Share on twitter failed: ", e);
    }

}
