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
    continueAfterRatelimitError: true,
    maxRetryAttempts: 5,
    requestDelay: 1000
});

let snooStream = SnooStream(r/*, drift = 10000*/);

var fs = require('fs');

const DATABASE_PATH = process.env.DATABASE_PATH;
const WALLET_PATH = process.env.WALLET_PATH;
const WALLET_PASSWORD = process.env.WALLET_PASSWORD;
const SUBREDDIT = process.env.REDDIT_SUBREDDIT;

const NETWORK = parseInt(process.env.NEM_NETWORK);
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

function startDaemon(wallet) {
    console.log("Starting daemon...");

    monitorComments();
    monitorPms(wallet);
    monitorTransactions(wallet);
}

function walletToWallet(fromUserWallet, toUserWallet, amount) {
    var fromUserAccount = getFirstAccount(fromUserWallet);
    var toUserAccount = getFirstAccount(toUserWallet);

    var fromUserDecrypted = {
        password: WALLET_PASSWORD
    };

    var algo = fromUserAccount.algo;

    nem.crypto.helpers.passwordToPrivatekey(fromUserDecrypted, fromUserAccount, algo);

    var common = nem.model.objects.create("common")(WALLET_PASSWORD, fromUserDecrypted.privateKey);

    var transferTransaction = nem.model.objects.create("transferTransaction")(toUserAccount.address, amount);

    var prepareTransferTransaction = nem.model.transactions.prepare("transferTransaction");

    var preparedTransferTransaction = prepareTransferTransaction(common, transferTransaction, NETWORK);

    var endpoint = nem.model.objects.create("endpoint")(ENDPOINT, nem.model.nodes.defaultPort);

    nem.model.transactions.send(common, preparedTransferTransaction, endpoint);
}

function userToUser(fromUsername, toUsername, amount) {
    console.log("Sending " + amount + " XEM from " + "\\u\\" + fromUsername + " to " + "\\u\\" + toUsername);

    User.findOne({ where: { username: fromUsername } })
        .then(fromUser => {
            if (fromUser && fromUser.wallet) {
                User.findOrCreate({ where: { username: toUsername }, defaults: { username: toUsername } })
                    .spread((toUser, created) => {
                        if (toUser && toUser.wallet) {
                            var fromUserWallet = JSON.parse(fromUser.wallet);
                            var toUserWallet = JSON.parse(toUser.wallet);

                            walletToWallet(fromUserWallet, toUserWallet, amount);
                        } else if (toUser && toUser.wallet == null) {
                            var fromUserWallet = JSON.parse(fromUser.wallet);
                            var toUserWallet = nem.model.wallet.createPRNG(toUsername,
                                WALLET_PASSWORD,
                                NETWORK);

                            toUser.wallet = JSON.stringify(toUserWallet);
                            toUser.save()
                                .then(() => {
                                    walletToWallet(fromUserWallet, toUserWallet, amount);
                                });
                        }
                    });
            }
        });
}

function processTransaction(botWallet, tx) {
    if (tx.transaction.message.type !== 2 && tx.transaction.message.payload) {
        //  Decode challenge code.
        var wordArray = nem.crypto.js.enc.Hex.parse(tx.transaction.message.payload);
        var challengeCode = nem.crypto.js.enc.Utf8.stringify(wordArray);

        User.findOne({ where: { challenge: challengeCode } }).then(user => {
            if (user) {
                var originPublicKey = tx.transaction.signer;

                var userWallet = nem.model.wallet.createPRNG(user.username,
                    WALLET_PASSWORD,
                    NETWORK);

                var userAccount = getFirstAccount(userWallet);

                var userCommon = {
                    password: WALLET_PASSWORD
                };

                nem.crypto.helpers.passwordToPrivatekey(userCommon, userAccount, userAccount.algo);

                user.challenge = challengeCode;
                user.wallet = JSON.stringify(userWallet);
                user.save();

                var botAccount = getFirstAccount(botWallet);

                var botCommon = {
                    password: WALLET_PASSWORD
                };

                var algo = botAccount.algo;

                nem.crypto.helpers.passwordToPrivatekey(botCommon, botAccount, algo);

                var common = nem.model.objects.create("common")(WALLET_PASSWORD, botCommon.privateKey);
                var publicAddress = nem.model.address.toAddress(originPublicKey, NETWORK);

                var transferTransaction = nem.model.objects.create("transferTransaction")(publicAddress, 0, userCommon.privateKey);

                transferTransaction.encryptMessage = true;
                transferTransaction.recipientPubKey = originPublicKey;

                var prepareTransferTransaction = nem.model.transactions.prepare("transferTransaction");

                var preparedTransferTransaction = prepareTransferTransaction(common, transferTransaction, NETWORK);

                var endpoint = nem.model.objects.create("endpoint")(ENDPOINT, nem.model.nodes.defaultPort);

                nem.model.transactions.send(common, preparedTransferTransaction, endpoint);

                var msg = {
                    to: user.username,
                    subject: "Account registered!",
                    text: "Hello again, /u/" + user.username + "!\r\n\r\n" +
                    "We've received your NEM transaction and your account has been successfully registered with the NEM tip bot!\r\n\r\n" +
                    "We've sent you an address containing your tip account private key. Funds will be used from that address " +
                    "so be sure it has XEM.\r\n\r\n" +
                    "Aside from that, you can start tipping immediately."
                }

                r.composeMessage(msg);
            }
        });
    }
}

function monitorComments() {
    let tipCommentStream = snooStream.commentStream(SUBREDDIT, { regex: /!tipxem\s+(\d+)/, rate: 30000 });

    tipCommentStream.on('post', (comment, match) => {
        var tipAmount = parseInt(match[1]);

        attemptTip(comment, tipAmount);
    });
}

function monitorPms(wallet) {
    r.getInbox("messages").then((res) => {
        console.log("\nIncoming PMs:");
        res.forEach((pm) => {
            Pm.findById(pm.id).then(privateMessage => {
                if (privateMessage == null) {
                    processPm(pm, wallet);

                    //  Mark pm as processed.
                    Pm.build({ id: pm.id }).save();
                }
            });
        })
    });

    setTimeout(monitorPms, 10000, wallet);
}

function monitorTransactions(botWallet) {
    var endpoint = nem.model.objects.create("endpoint")(ENDPOINT, nem.model.nodes.defaultPort);

    var account = getFirstAccount(botWallet);

    nem.com.requests.account.incomingTransactions(endpoint, account.address).then(function (res) {
        console.log("\nIncoming transactions:");

        res.forEach((tx) => {
            Tx.findById(tx.meta.id).then(transaction => {
                if (transaction == null) {
                    processTransaction(botWallet, tx);

                    //  Mark transaction as processed.
                    Tx.build({ id: tx.meta.id }).save();
                }
            });
        });
    }, function (err) {
        console.error(err);
    });

    setTimeout(monitorTransactions, 5000, botWallet);
}

function processPm(pm, wallet) {
    if (pm.body === "register") {
        var username = pm.author.name;

        User.findOne({ where: { username: username } }).then(user => {
            var wa = nem.crypto.js.lib.WordArray.random(8);
            var challengeCode = wa.toString();
            var account = getFirstAccount(wallet);

            var registerMessage = "Hello, /u/" + username + "!\r\n\r\n" +
                "please send a message to the NEM address: " + account.address + "\r\n\r\n" +
                "Your message must contain the following challenge code: " + "\r\n\r\n" +
                "    " + challengeCode + "\r\n\r\n" +
                "and 6 XEM to send you your encrypted private key. If you do not include the" +
                " 6 XEM in your transaction, we will not be able to send you your encrypted private key.";

            console.log(message);

            //  Never registered and no one has tipped them.
            if (user == null) {
                User.create({ username: username, challenge: challengeCode })
                    .then(() => {
                        pm.reply(message);
                    })
                    .catch(error => {
                        console.log("Error creating user.");
                        console.log(error);
                    });
            }
            //  Never registered but someone has tipped them.
            else if (user && user.wallet != null && user.challengeCode == null) {
                user.challenge = challengeCode;
                user.save()
                    .then(() => {
                        pm.reply(message);
                    }).catch(error => {
                        console.log("Error saving user.");
                        console.log(error);
                    });
            }
            //  Already registered.
            else if (user && user.wallet != null && user.challengeCode != null) {
                //  Send new challenge code to recover private key?
                console.log("This user has already registered.");
            }
        });
    }
}

function getFirstAccount(wallet) {
    return wallet.accounts[0];
}

function attemptTip(comment, tipAmount) {
    console.log("Attempting Tip!");

    console.log(comment);
    console.log(tipAmount);

    Comment
        .findOrCreate({ where: { id: comment.id }, defaults: { id: comment.id } })
        .spread((ct, created) => {
            var parentCommentId = null;

            if (/^(t\d|LiveUpdateEvent)_/.test(comment.parent_id)) {
                parentCommentId = comment.parent_id.split("_").pop();
            }

            r.getComment(parentCommentId).fetch().then(c => {
                var fromAuthor = comment.author.name;
                var toAuthor = c.author.name;

                var tipMessage = "Hello, /u/" + toAuthor + "!\r\n\r\n" +
                    "You received a tip of " + tipAmount + "XEM!\r\n\r\n" +
                    "If you haven't already registered, please send me a PM with the following body:\r\n\r\n" +
                    "    " + "register" + "\r\n\r\n" +
                    "_Disclaimer: I am a bot_" + "\r\n\r\n";

                comment.reply(tipMessage);

                userToUser(fromAuthor, toAuthor, tipAmount);
            });
        });
}
