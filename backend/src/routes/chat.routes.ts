import { Router } from "express";
import { verificarToken } from "../middlewares/auth.middleware";
import { limitadorChat } from "../middlewares/limites.middleware";
import { ctrlChat } from "../controllers/chat.controller";

const router = Router();

router.post("/", verificarToken, limitadorChat, ctrlChat);

export default router;
