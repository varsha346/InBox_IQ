module.exports = (sequelize, DataTypes) => {

  const Label = sequelize.define("Label", {

    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },

    name: DataTypes.STRING

  }, {
    tableName: "labels",
    timestamps: false
  });

  return Label;
};