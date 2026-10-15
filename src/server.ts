// src\server.ts
import express from "express";
import dotenv from "dotenv";
import { connectDB } from "./config/dbConn";
import mainRouter from "./routes/mainRoutes";

// init
const app = express();
const PORT = process.env.PORT || 5050;

// middleware
dotenv.config();
app.use(express.json());
app.use("/api", mainRouter);

// start up     
const startServer = async () => {
    await connectDB();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
};

startServer();