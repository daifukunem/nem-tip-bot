module.exports = (sequelize, DataTypes) => {
    return sequelize.define('user',
        {
            username: {
                type: DataTypes.STRING
            },
            challenge: {
                type: DataTypes.STRING
            },
            wallet: {
                type: DataTypes.STRING
            }
        });
}