require('dotenv').config();

var nem = require('nem-sdk').default;
var sqlite3 = require('sqlite3').verbose();
var snoowrap = require('snoowrap');
const SnooStream = require('snoostream');

var r = new snoowrap({
    userAgent: process.env.REDDIT_USER_AGENT,
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    accessToken: process.env.REDDIT_ACCESS_TOKEN,
    refreshToken: process.env.REDDIT_REFRESH_TOKEN
});

r.config({
    continueAfterRatelimitError: true
});

let snooStream = SnooStream(r);

var fs = require('fs');

const DATABASE_PATH = process.env.DATABASE_PATH;
const WALLET_PATH = process.env.WALLET_PATH;
const WALLET_PASSWORD = process.env.WALLET_PASSWORD;
const SUBREDDIT = process.env.REDDIT_SUBREDDIT;

const NETWORK = process.env.NEM_NETWORK;
const ENDPOINT = process.env.NEM_ENDPOINT;

var db = new sqlite3.Database(DATABASE_PATH);

db.serialize(function () {
    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='comments'", function (err, row) {
        if (row == null) {
            console.log("No comments table found, creating table.");
            db.run("CREATE TABLE comments (id TEXT)");
        }
    });

    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='pms'", function (err, row) {
        if (row == null) {
            console.log("No pms table found, creating table.");
            db.run("CREATE TABLE pms (id TEXT)");
        }
    });

    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='txs'", function (err, row) {
        if (row == null) {
            console.log("No transactions table found, creating table.");
            db.run("CREATE TABLE txs (id TEXT)");
        }
    });

    db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'", function (err, row) {
        if (row == null) {
            console.log("No users table found, creating table.");
            db.run("CREATE TABLE users (id TEXT, challenge TEXT, wallet TEXT)");
        }
    });
});

fs.stat(WALLET_PATH, function (err, stat) {
    if (err) {
        if (err.code == "ENOENT") {
            console.log("Wallet not found, creating new wallet.");

            var wallet = nem.model.wallet.createPRNG("nem-tip-bot",
                WALLET_PASSWORD,
                NETWORK);
            var wordArray = nem.crypto.js.enc.Utf8.parse(JSON.stringify(wallet));
            var base64 = nem.crypto.js.enc.Base64.stringify(wordArray);

            fs.writeFile(WALLET_PATH, base64, (err) => {
                if (err) throw err;

                startDaemon(wallet);
            });
        }
    } else {
        console.log("Wallet found, loading existing wallet.");

        fs.readFile(WALLET_PATH, (err, data) => {
            var base64 = data.toString();
            var wordArray = nem.crypto.js.enc.Base64.parse(base64);
            var wallet = JSON.parse(nem.crypto.js.enc.Utf8.stringify(wordArray));

            console.log(wallet);

            startDaemon(wallet);
        });
    }
});

function isNewObj(objId, objTable, cb) {
    db.serialize(function () {
        db.get("SELECT * FROM " + objTable + " WHERE id = ?", [objId], function (err, row) {
            cb(row == null);
        });
    });
}

function updateUser(username, data, cb) {
    isNewObj(username, 'users', (res) => {
        if (res) {
            db.serialize(function () {
                var stmt = db.prepare("INSERT INTO " + objTable + " VALUES (?)");

                for (var key in data) {
                    stmt.run(data[key]);
                }

                stmt.finalize();
            });
        } else {
            db.serialize(function () {
                var stmt = db.prepare("UPDATE " + objTable + " VALUES (?) WHERE id = ?");

                for (var key in data) {
                    stmt.run(data[key]);
                }

                stmt.finalize();
            });
        }
    });
}

function markObjProcessed(objId, objTable) {
    db.serialize(function () {
        var stmt = db.prepare("INSERT INTO " + objTable + " VALUES (?)");
        stmt.run(objId);
        stmt.finalize();
    });
}

function startDaemon(wallet) {
    console.log("Starting daemon...");

    var endpoint = nem.model.objects.create("endpoint")(ENDPOINT,
        nem.model.nodes.defaultPort);

    monitorComments();
    monitorPms(wallet);

    var endpoint = nem.model.objects.create("endpoint")(ENDPOINT, nem.model.nodes.defaultPort);

    var account = getFirstAccount(wallet);

    nem.com.requests.account.incomingTransactions(endpoint, account.address).then(function (res) {
        console.log("\nIncoming transactions:");

        var common = {
            password: WALLET_PASSWORD
        };

        var algo = account.algo;

        nem.crypto.helpers.passwordToPrivatekey(common, account, algo);

        res.forEach((tx) => {
            isNewObj(tx.meta.id, "tx", (isNew) => {
                if (isNew) {
                    if (tx.transaction.message.type !== 2) {
                        console.log(tx.transaction.signer);
                        console.log(tx.transaction.message);

                        if (tx.transaction.message.payload) {
                            //  Decode
                            var wordArray = nem.crypto.js.enc.Hex.parse(tx.transaction.message.payload);
                            var dec = nem.crypto.js.enc.Utf8.stringify(wordArray);

                            try {
                                getUserByChallengeCode(dec, (err, row) => {
                                    if (row) {
                                        var username = row.id;

                                        var wallet = nem.model.wallet.createPRNG(username,
                                            WALLET_PASSWORD,
                                            NETWORK);

                                        updateUser(username, {
                                            id: username,
                                            challenge: dec,
                                            wallet: wallet
                                        });

                                        var username = row.id;

                                        var msg = {
                                            to: username,
                                            subject: "Account registered!",
                                            text: "Hello again, /u/" + username + "!\r\n\r\n" +
                                            "We received your NEM transaction and your account has been successfully registered with the nem tip bot!\r\n\r\n" +
                                            "We've sent you an address containing your " +
                                            "You can start tipping immediately."
                                        }

                                        r.composeMessage(msg);

                                        markObjProcessed(tx.meta.id, 'txs');
                                    }
                                });
                            } catch (e) {
                                console.log(e);
                            }
                        }
                    }
                }
            });
        })
    }, function (err) {
        console.error(err);
    });
}

function monitorComments() {
    let tipCommentStream = snooStream.commentStream(SUBREDDIT, { regex: /!tip\s+(\d+)/ });

    tipCommentStream.on('post', (comment, match) => {
        var tipAmount = parseInt(match[1]);

        attemptTip(comment, tipAmount);
    });
}

function monitorPms(wallet) {
    setInterval(() => {
        r.getInbox("messages").then((res) => {
            res.forEach((pm) => {
                processPm(pm, wallet);
            })
        });
    }, 10000);
}

function processPm(pm, wallet) {
    isNewObj(pm.id, 'pms', (res) => {
        if (res) {
            if (pm.new && pm.body === "register") {
                //  Mark the PM as read first, this prevents
                //  us accidentally spamming due to errors.
                pm.markAsRead();

                var username = pm.author.name;
                var challengeCode = nem.crypto.js.lib.WordArray.random(8);

                console.log("ChallengeCode: " + challengeCode);

                var account = getFirstAccount(wallet);

                var message = "Hello, /u/" + username + "!\r\n\r\n" +
                    "please send a message to the NEM address: " + account.address + "\r\n\r\n" +
                    "Your message must contain the following challenge code: " + "\r\n\r\n" +
                    "    " + challengeCode + "\r\n"

                console.log(message);

                updateUser(username, {
                    id: username,
                    challenge: challengeCode
                });

                pm.reply(message);
            }
        }
    });
}

function getUserByChallengeCode(challengeCode, cb) {
    db.serialize(function () {
        db.get("SELECT * FROM users WHERE challenge = ?", [challengeCode], function (err, row) {
            cb(err, row);
        });
    });
}

function encString(wallet, str) {
    var account = getFirstAccount(wallet);

    var common = {
        password: WALLET_PASSWORD
    };

    var algo = account.algo;

    nem.crypto.helpers.passwordToPrivatekey(common, account, algo);

    let kp = nem.crypto.keyPair.create(common.privateKey);

    var enc = nem.crypto.helpers.encode(common.privateKey, kp.publicKey.toString(), str);

    return enc;
}

function decString(wallet, str) {
    var account = getFirstAccount(wallet);

    var common = {
        password: WALLET_PASSWORD
    };

    var algo = account.algo;

    nem.crypto.helpers.passwordToPrivatekey(common, account, algo);

    let kp = nem.crypto.keyPair.create(common.privateKey);

    var hex = nem.crypto.helpers.decode(common.privateKey, kp.publicKey.toString(), str);

    var dec = nem.crypto.js.enc.Hex.parse(hex);

    var decString = nem.crypto.js.enc.Utf8.stringify(dec);

    return decString;
}

function getFirstAccount(wallet) {
    return wallet.accounts[0];
}

function postCommentReply(comment, body) {
    comment.reply(body);
}

function attemptTip(comment, tipAmount) {
    isNewObj(comment.id, 'comments', (res) => {
        if (res) {
            console.log("Process the tip!");

            postCommentReply(comment, "Test reply");

            markObjProcessed(comment.id, 'comments');
        }
    });
}

function processNewMessages() {

}

function processNewTransactions() {

}
