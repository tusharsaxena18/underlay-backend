# AGENTS.md
## Project Overview
Underlay Backend is a TypeScript backend built with Node.js and Express.
The project also uses:

- MongoDB
- Mongoose
- Typegoose
- LangChain
- dotenv

The backend contains an AI agent system, API routes, services, shared types, and database configuration.
---
# Libraries / Current Stack
- Runtime & Language
Node.js — Backend runtime
TypeScript 5.9 — Primary development language
- Backend
Express 5 — HTTP server and REST API
Mongoose 9 — MongoDB ODM and database connectivity
Typegoose 13 — TypeScript models for Mongoose
dotenv — Environment variable management
- AI
LangChain 1.5 — LLM and AI agent orchestration
use @LangchainDocs.md to learn about it

---
# Project Structure
```text
src/
├── agents/
│   └── orchestrator.ts
├── config/
│   └── dbConn.ts
├── routes/
│   └── mainRoutes.ts
├── services/
│   └── service.ts
├── tests/
│   └── test.ts
├── types/
│   └── schema.ts
└── server.ts
```

## General Development Rules
Before modifying the project:
- Inspect the existing implementation.
- Understand how the relevant module currently works.
- Reuse existing functionality when appropriate.
- Avoid changing unrelated files.
- Keep new functionality within the appropriate part of the project structure.
- Follow existing naming and coding conventions.
- Write clean, production-quality code.
- Add concise comments for non-obvious logic.
- Remove unused code/imports introduced during development.
- Do not over-engineer simple features.

When a feature belongs to a specific module, encapsulate that module inside its own folder under services/ rather than adding unrelated files directly to services/.

Shared utilities are the exception: genuinely reusable functionality may be placed in an appropriate shared utility location.

### Database
MongoDB is accessed through Mongoose and Typegoose.
The application establishes the MongoDB connection during startup.
Do not create a new database connection from individual services, routes, or agents.
Database models should be kept separate from business logic.
If the number of models grows significantly, create a dedicated:
src/models/
directory.

### Environment Variables
Environment variables are loaded by the application's entry point.
Use:
```js
process.env.VARIABLE_NAME
```
for environment configuration.
Never hardcode:

- API keys
- Database credentials
- Secrets
- Tokens
.env contains local configuration and should not be committed.
.env.example should document the required environment variables without containing real secrets.

### Comments

- Write useful comments where they improve understanding.
- Comments should explain:
- Why something is implemented a particular way
- Non-obvious logic
- Important architectural decisions
- Complex algorithms or workflows
- External constraints

Do not add comments that simply restate obvious code.
Bad:
```js
// Increment counter
counter++;
```
Good:
```js
// Retry only failed agents so successful results are not recomputed.
```
Keep comments concise and accurate.

### Code Quality

Write clean, readable, maintainable TypeScript.

Prefer:

- Clear naming
- Small focused functions
- Strong typing
- Explicit interfaces/types where useful
- Early validation
- Proper error handling
- Reusable code where appropriate

Avoid:

- Unnecessary ```any``` type for variables as you will write typescript
- Duplicated logic
- Extremely large functions
- Extremely large files
- Deeply nested logic
- Unnecessary abstractions
- Dead code
- Unused imports
- Hardcoded secrets or API keys

Use the existing project's conventions rather than introducing a different style for a single feature.

### Types
All Types must be stored in the src/types/ directory check if a type already exists before making your own duplicate.

### services
src/services/
Contains the application's business and application logic.
This is where the actual functionality of backend modules should live.

### Routes
src/routes/
Contains Express API route definitions.
Routes are responsible for defining the HTTP interface of the backend and connecting HTTP endpoints to the appropriate application logic.

### Config
src/config/
Contains application-wide configuration and infrastructure setup.