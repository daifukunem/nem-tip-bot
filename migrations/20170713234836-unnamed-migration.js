'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn('users', 'cosignerWallet', Sequelize.STRING);
  },

  down: function (queryInterface, Sequelize) {
    return queryInterface.removeColumn('users', 'cosignerWallet');
  }
};
