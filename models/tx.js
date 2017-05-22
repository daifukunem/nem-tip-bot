module.exports = (sequelize, DataTypes) => {
    return sequelize.define('tx',
        {
            id: {
                primaryKey: true,
                type: DataTypes.STRING
            },
        });
}