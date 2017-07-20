require('dotenv').config();

var nem = require('nem-sdk').default;
var snoowrap = require('snoowrap');
const SnooStream = require('snoostream');
const Sequelize = require('sequelize');

var _ = require('underscore');

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

let snooStream = SnooStream(r/*, drift = 2000*/);

var fs = require('fs');

const DATABASE_PATH = process.env.DATABASE_PATH;
const WALLET_PATH = process.env.WALLET_PATH;
const WALLET_PASSWORD = process.env.WALLET_PASSWORD;
const SUBREDDIT = process.env.REDDIT_SUBREDDIT;

const NETWORK = parseInt(process.env.NEM_NETWORK);
const ENDPOINT = process.env.NEM_ENDPOINT;

var ep = nem.model.objects.create("endpoint")(nem.model.nodes.defaultTestnet, nem.model.nodes.websocketPort);

ep.host = "http://23.228.67.85"

var address = "";
var connector = nem.com.websockets.connector.create(ep, address);

function connect(connector) {
    return connector.connect().then(function () {
        date = new Date();

        console.log(date.toLocaleString() + ': Connected to: ' + connector.endpoint.host);

        nem.com.websockets.subscribe.chain.blocks(connector, function (res) {
            date = new Date();

            console.log(date.toLocaleString() + ': ' + JSON.stringify(res) + '');

            processBlock(res);
        });
    });
}

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

startDaemon();

function startDaemon() {
    console.log("Starting daemon...");

    monitorComments();
    monitorPms();

    //  Monitor Blocks
    connect(connector);
}

function walletToWallet(fromUserWallet, fromUserCosignerWallet, toUserWallet, amount) {
    var fromUserAccount = getFirstAccount(fromUserWallet);
    var fromUserCosignerAccount = getFirstAccount(fromUserCosignerWallet);
    var toUserAccount = getFirstAccount(toUserWallet);

    //  Multi-sig account
    var fromUserDecrypted = {
        password: WALLET_PASSWORD
    };

    var algo = fromUserAccount.algo;

    nem.crypto.helpers.passwordToPrivatekey(fromUserDecrypted, fromUserAccount, algo);

    var fromUserCommon = nem.model.objects.create("common")(WALLET_PASSWORD, fromUserDecrypted.privateKey);

    var fromUserKp = nem.crypto.keyPair.create(fromUserDecrypted.privateKey);


    //  Cosigner-account
    var fromUserCosignerDecrypted = {
        password: WALLET_PASSWORD
    };

    algo = fromUserCosignerAccount.algo;

    nem.crypto.helpers.passwordToPrivatekey(fromUserCosignerDecrypted, fromUserCosignerAccount, algo);

    var fromUserCosignerCommon = nem.model.objects.create("common")(WALLET_PASSWORD, fromUserCosignerDecrypted.privateKey);

    var fromUserCosignerKp = nem.crypto.keyPair.create(fromUserCosignerDecrypted.privateKey);

    //  Create multi-sig transfer transaction
    var transferTransaction = nem.model.objects.create("transferTransaction")(toUserAccount.address, amount);
    transferTransaction.isMultisig = true;
    transferTransaction.multisigAccount = { publicKey: fromUserKp.publicKey.toString() };

    var prepareTransferTransaction = nem.model.transactions.prepare("transferTransaction");

    var preparedTransferTransaction = prepareTransferTransaction(fromUserCosignerCommon, transferTransaction, NETWORK);

    var endpoint = nem.model.objects.create("endpoint")(ENDPOINT, nem.model.nodes.defaultPort);

    nem.model.transactions.send(fromUserCosignerCommon, preparedTransferTransaction, endpoint).then((res) => {
        console.log(res);
    });
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
                            var fromUserCosignerWallet = JSON.parse(fromUser.cosignerWallet);
                            var toUserWallet = JSON.parse(toUser.wallet);

                            walletToWallet(fromUserWallet, fromUserCosignerWallet, toUserWallet, amount);
                        } else if (toUser && toUser.wallet == null) {
                            var fromUserWallet = JSON.parse(fromUser.wallet);
                            var toUserWallet = nem.model.wallet.createPRNG(toUsername,
                                WALLET_PASSWORD,
                                NETWORK);

                            var toUserCosignerWallet = nem.model.wallet.createPRNG(toUsername + '_cosigner',
                                WALLET_PASSWORD,
                                NETWORK);

                            toUser.wallet = JSON.stringify(toUserWallet);
                            toUser.cosignerWallet = toUserCosignerWallet;

                            var toUserAccount = getFirstAccount(toUserAccount);

                            toUser.address = toUserAccount[0].address;
                            toUser.registered = false;

                            toUser.save()
                                .then(() => {
                                    walletToWallet(fromUserWallet, fromUserCosignerWallet, toUserWallet, amount);
                                });
                        }
                    });
            }
        });
}

function processBlock(block) {
    console.log("Processing block: ");

    var transactions = block['transactions'];

    User.findAll({
        attributes: ['address'],
        where: {
            address: {
                $ne: null
            },
            $or: [
                {
                    registered: {
                        $eq: null
                    }
                },
                {
                    registered: {
                        $eq: false
                    }
                },
            ]
        }
    }).then(res => {
        var monitoredAddresses = _.pluck(res, 'address');

        var filteredTxs = _.filter(transactions, function (tx) {
            return _.indexOf(monitoredAddresses, tx.recipient) != -1;
        });

        for (var i = 0; i < filteredTxs.length; ++i) {
            processTransaction(filteredTxs[i]);
        }

        console.log("Monitored Addresses: " + monitoredAddresses);
        console.log("Filtered Txs: " + filteredTxs);
    });
}

function processTransaction(tx) {
    if (tx.message.type !== 2 && tx.message.payload) {
        //  Decode challenge code.
        var wordArray = nem.crypto.js.enc.Hex.parse(tx.message.payload);
        var message = nem.crypto.js.enc.Utf8.stringify(wordArray);

        var challengeCode = null;
        var publicKey = null;

        var lines = message.split(/\r|\n|\s/);

        if (lines.length == 2) {
            challengeCode = lines[0];
            publicKey = lines[1];
        } else {
            return;
        }

        User.findOne({ where: { challenge: challengeCode } }).then(user => {
            if (user) {
                var originPublicKey = tx.signer;

                var userWallet = nem.model.wallet.createPRNG(user.username,
                    WALLET_PASSWORD,
                    NETWORK);

                var userCosignerWallet = nem.model.wallet.createPRNG(user.username + '_cosigner',
                    WALLET_PASSWORD,
                    NETWORK);

                if (!user.wallet || user.wallet == null) {
                    user.wallet = JSON.stringify(userWallet);
                } else {
                    userWallet = JSON.parse(user.wallet);
                }

                if (!user.cosignerWallet || user.cosignerWallet == null) {
                    user.cosignerWallet = JSON.stringify(userCosignerWallet);
                } else {
                    userCosignerWallet = JSON.parse(user.cosignerWallet)
                }

                var userAccount = getFirstAccount(userWallet);
                var cosignerAccount = getFirstAccount(userCosignerWallet);

                var userCommon = {
                    password: WALLET_PASSWORD
                };

                var cosignerCommon = {
                    password: WALLET_PASSWORD
                };

                nem.crypto.helpers.passwordToPrivatekey(userCommon, userAccount, userAccount.algo);
                nem.crypto.helpers.passwordToPrivatekey(cosignerCommon, cosignerAccount, cosignerAccount.algo);

                user.address = userAccount.address;

                user.save();

                var common = nem.model.objects.create("common")(WALLET_PASSWORD, userCommon.privateKey);
                var publicAddress = nem.model.address.toAddress(originPublicKey, NETWORK);

                var kp = nem.crypto.keyPair.create(cosignerCommon.privateKey);

                var multisigAggregateModificationTransaction =
                    {
                        isMultiSig: false,
                        modifications: [
                            {
                                'modificationType': 1,
                                'cosignatoryAccount': originPublicKey
                            },
                            {
                                'modificationType': 1,
                                'cosignatoryAccount': publicKey
                            },
                            {
                                'modificationType': 1,
                                'cosignatoryAccount': kp.publicKey.toString()
                            }
                        ],
                        minCosignatories: {
                            "relativeChange": 2
                        },
                        relativeChange: 2
                    }

                console.log(multisigAggregateModificationTransaction);

                var prepareMultisigAggModTransaction = nem.model.transactions.prepare("multisigAggregateModificationTransaction");

                var preparedMultisigAggModTransaction = prepareMultisigAggModTransaction(common, multisigAggregateModificationTransaction, NETWORK);

                var endpoint = nem.model.objects.create("endpoint")(ENDPOINT, nem.model.nodes.defaultPort);

                nem.model.transactions.send(common, preparedMultisigAggModTransaction, endpoint).then((res) => {
                    console.log(res);

                    if (res.code == 1) {
                        user.registered = true;
                        user.save();

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
                    } else {
                        var msg = {
                            to: user.username,
                            subject: "Registration error!",
                            text: "Hello again, /u/" + user.username + "!\r\n\r\n" +
                            "We've received your NEM transaction however there was an error when trying to create the multi-sig account.\r\n\r\n" +
                            "Please verify your transaction contained the correct public-key in the message and enough XEM to create the multi-sig account."
                        }

                        r.composeMessage(msg);
                    }
                });
            }
        });
    }
}

function monitorComments() {
    let tipCommentStream = snooStream.commentStream(SUBREDDIT, { regex: /!tipxem\s+((?=.*\d)\d*(?:\.\d+)?)/, rate: 30000 });

    tipCommentStream.on('post', (comment, match) => {
        var tipAmount = parseFloat(match[1]).toFixed(6);

        //  Don't try to tip if this number isn't valid.
        if (isFinite(tipAmount) && tipAmount > 0) {
            attemptTip(comment, tipAmount);
        }
    });
}

function monitorPms() {
    r.getInbox("messages").then((res) => {
        console.log("\nIncoming PMs:");
        res.forEach((pm) => {
            Pm.findById(pm.id).then(privateMessage => {
                if (privateMessage == null) {
                    processPm(pm);

                    //  Mark pm as processed.
                    Pm.build({ id: pm.id }).save();
                }
            });
        })
    });

    setTimeout(monitorPms, 10000);
}

function getRegisterMessage(username, address, challengeCode) {
    var registerMessage = "Hello, /u/" + username + "!\r\n\r\n" +
        "Reddit tipbot is a 2FA trustless tipping bot! Your funds are always safe.\r\n" +
        "It is controlled by a 2-of-3 multisig account, with you in charge of 2 of the keys.\r\n" +
        "When you leave a comment on Reddit to tip, the tipbot will initiate a transaction for you. " + 
        "Once the transaction has been initiated, you will need to approve it from within your NanoWallet." +

        "Please send a message from the acount you would like to 2FA approve tips from.\r\n\r\n" + 
        "Send the message to the the NEM address: " + address + "\r\n\r\n" +
        "Your message must contain the following challenge code: " + "\r\n\r\n" +
        "    " + challengeCode + "\r\n\r\n" +
        "Along with this code, please send the public-key of a seperate backup cosigner account." +
        "You can retrieve the public-key from Nano Wallet." +
        "Below is an _example_ of a registration message: " + "\r\n\r\n" +
        "    " + challengeCode + "\r\n\r\n" +
        "    " + "1c9ffd4361887a5bb448060df37b2f500c51580e57d512f97dddc7b7e547508a" + "\r\n\r\n" +
        "After registering these two accounts, you will have full control of your funds to make transactions " +
        "even without the tipbot. Also, since the tipbot only controls 1-of-3 keys, it will never be able to spend " +
        "your money without your permission." + "\r\n\r\n" +
        "The tipbot's main job is to make tipping as easy as possible for you. It watches reddit for any tips you'd like to send and " +
        "will automatically begin a transaction on your behalf. All you need to do is approve the transaction in your 2FA account. " +
        "No need to know the other peron's address or prepare a transaction, the hard part has been automated for you by the NEM Reddit tipbot.";

    console.log(registerMessage);

    return registerMessage;
}

function processPm(pm) {
    console.log(pm);

    if (pm.subject === "register" || pm.body === "register") {
        var username = pm.author.name;

        User.findOne({ where: { username: username } }).then(user => {
            var wa = nem.crypto.js.lib.WordArray.random(8);
            var challengeCode = wa.toString();

            //  Never registered and no one has tipped them.
            if (user == null) {
                var userWallet = nem.model.wallet.createPRNG(username,
                    WALLET_PASSWORD,
                    NETWORK);

                var userWalletJson = JSON.stringify(userWallet);

                var userCosignerWallet = nem.model.wallet.createPRNG(username + '_cosigner',
                    WALLET_PASSWORD,
                    NETWORK);

                var userCosignerWalletJson = JSON.stringify(userCosignerWallet);

                var account = getFirstAccount(userWallet);

                var registerMessage = getRegisterMessage(username, account.address, challengeCode);

                User.create({
                    username: username,
                    challenge: challengeCode,
                    wallet: userWalletJson,
                    cosignerWallet: userCosignerWalletJson,
                    registered: false,
                    address: account.address
                })
                    .then(() => {
                        pm.reply(registerMessage);
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
                        pm.reply(registerMessage);
                    })
                    .catch(error => {
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
                    "If you haven't already registered, please send me a PM with the following subject or body:\r\n\r\n" +
                    "    " + "register" + "\r\n\r\n" +
                    "_Disclaimer: I am a bot_" + "\r\n\r\n";

                comment.reply(tipMessage);

                userToUser(fromAuthor, toAuthor, tipAmount);
            });
        });
}
