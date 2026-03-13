const express = require("express"); 
const router = express.Router();
const userService = require("../services/userservice");

router.post("/create", userService.create);
router.get("/:userId", userService.getById);
router.get("/email/:email", userService.getByEmail);
router.get("/", userService.getAll);
router.put("/:userId", userService.update);
router.post("/:userId/tokens", userService.saveUserTokens);
router.delete("/:userId", userService.delete);

module.exports = router;