'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn('users', 'registered', Sequelize.BOOLEAN);
  },

  down: function (queryInterface, Sequelize) {
    return queryInterface.removeColumn('users', 'registered');
  }
};
