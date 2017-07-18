'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn('users', 'address', Sequelize.STRING);
  },

  down: function (queryInterface, Sequelize) {
    return queryInterface.removeColumn('users', 'address');
  }
};
