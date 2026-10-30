import express from "express";
import { getUploadUrl, getReadUrl } from "../controllers/media.controller";
import { protect } from "../middleware/auth.middleware";

const router = express.Router();

// Both patient and caregiver can upload media
router.post("/upload-url", protect, getUploadUrl);

router.post("/read-url", protect, getReadUrl);
export default router;
