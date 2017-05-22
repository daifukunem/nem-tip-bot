module.exports = (sequelize, DataTypes) => {
    return sequelize.define('comment',
        {
            id: {
                primaryKey: true,
                type: DataTypes.STRING
            },
        });
}