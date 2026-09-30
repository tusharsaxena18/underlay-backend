import { Router } from "express";

const mainRouter = Router();

mainRouter.get("/health", () => {
  return {
    message: "API is running",
  };
});

export default mainRouter;