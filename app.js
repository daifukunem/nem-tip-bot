require('dotenv').config();

var nem = require('nem-sdk').default;
var snoowrap = require('snoowrap');
const SnooStream = require('snoostream');
const Sequelize = require('sequelize');

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

const sequelize = new Sequelize({ dialect: 'sqlite', storage: DATABASE_PATH });

sequelize
    .authenticate()
    .then(() => {
        console.log('Connection has been established successfully.');
    })
    .catch(err => {
        console.error('Unable to connect to the database:', err);
    });

const User = sequelize.import(__dirname + "/models/user.js");
const Pm = sequelize.import(__dirname + "/models/pm.js");
const Comment = sequelize.import(__dirname + "/models/comment.js");
const Tx = sequelize.import(__dirname + "/models/tx.js");

sequelize.sync().then(() => {
    console.log("Tables synced");
}).catch(error => {
    console.log("Error syncing tables");
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
    monitorTransactions(wallet);
}

function monitorTransactions(wallet) {
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
            Tx.findById(tx.meta.id).then(transaction => {
                if (transaction == null) {
                    if (tx.transaction.message.type !== 2 && tx.transaction.message.payload) {
                        //  Decode
                        var wordArray = nem.crypto.js.enc.Hex.parse(tx.transaction.message.payload);
                        var challengeCode = nem.crypto.js.enc.Utf8.stringify(wordArray);

                        User.findOne({ where: { challenge: challengeCode } }).then(user => {
                            if (user) {
                                var wallet = nem.model.wallet.createPRNG(user.username,
                                    WALLET_PASSWORD,
                                    NETWORK);

                                user.challenge = challengeCode;
                                user.wallet = JSON.stringify(wallet);

                                user.save();

                                var msg = {
                                    to: user.username,
                                    subject: "Account registered!",
                                    text: "Hello again, /u/" + user.username + "!\r\n\r\n" +
                                    "We received your NEM transaction and your account has been successfully registered with the nem tip bot!\r\n\r\n" +
                                    "We've sent you an address containing your " +
                                    "You can start tipping immediately."
                                }

                                r.composeMessage(msg);
                            }
                        });
                    }

                    //  Mark transaction as processed.
                    Tx.build({id: tx.meta.id}).save();
                }
            });
        });
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
    Comment
        .findOrCreate({ where: { id: comment.id }, defaults: { id: comment.id } })
        .then(ct => {
            postCommentReply(comment, "Test reply");
        });
}

function processNewMessages() {

}

function processNewTransactions() {

}
