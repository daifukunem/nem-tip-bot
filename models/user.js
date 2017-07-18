module.exports = (sequelize, DataTypes) => {
    return sequelize.define('user',
        {
            username: {
                type: DataTypes.STRING
            },
            challenge: {
                type: DataTypes.STRING
            },
            //  Address of the multisig-account. Faster than trying to use the wallet.
            address: {
                type: DataTypes.STRING
            },
            //  First account is the multisig-account.
            wallet: {
                type: DataTypes.STRING
            },
            //  Second account, bot co-signer account.
            cosignerWallet: {
                type: DataTypes.STRING
            },
            //  Has the user registered?
            registered: {
                type: DataTypes.BOOLEAN
            }
       });
}