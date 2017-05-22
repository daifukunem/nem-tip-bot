module.exports = (sequelize, DataTypes) => {
    return sequelize.define('pm',
        {
            id: {
                primaryKey: true,
                type: DataTypes.STRING
            },
        });
}