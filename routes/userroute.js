const express = require("express"); 
const router = express.Router();
const userService = require("../services/userservice");
const { authenticateToken } = require("../middlewares/authmiddleware");

// All user management routes are protected
router.post("/create", authenticateToken, userService.create);
router.get("/email/:email", authenticateToken, userService.getByEmail);
router.get("/", authenticateToken, userService.getAll);
router.put("/profile/:userId", authenticateToken, userService.update);
router.get("/:userId", authenticateToken, userService.getById);
router.put("/:userId", authenticateToken, userService.update);
router.delete("/:userId", authenticateToken, userService.delete);

module.exports = router;