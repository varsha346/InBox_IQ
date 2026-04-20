const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middlewares/authmiddleware");
const taskService = require("../services/taskservice");

router.post("/auto/:emailId", authenticateToken, taskService.autoCreateFromEmail);
router.get("/", authenticateToken, taskService.getAllTasksAndEvents);
router.post("/", authenticateToken, taskService.manualCreate);
router.put("/:id", authenticateToken, taskService.updateTaskOrEvent);
router.delete("/:id", authenticateToken, taskService.deleteTaskOrEvent);

module.exports = router;
