import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { ctrlChat } from "../controllers/chat.controller";

const router = Router();

router.post("/", verificarToken, ctrlChat);

export default router;
