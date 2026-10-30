import express from "express";
import { getUploadUrl, getReadUrl, deleteMedia } from "../controllers/media.controller";
import { protect } from "../middleware/auth.middleware";

const router = express.Router();

// Both patient and caregiver can upload media
router.post("/upload-url", protect, getUploadUrl);

router.post("/read-url", protect, getReadUrl);
router.delete("/object", protect, deleteMedia);
export default router;
