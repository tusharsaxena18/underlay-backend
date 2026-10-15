// src\services\keyManager.ts
export class GeminiKeyManager {
    private readonly keys: string[];
    private currentIndex = 0;

    constructor(keys: string[]) {
        this.keys = keys.filter((key) => key.trim().length > 0);

        if (this.keys.length === 0) {
            throw new Error("No Gemini API keys configured.");
        }
    }

    getNextKey(): string {
        const index = this.currentIndex;
        const key = this.keys[index]!;

        this.currentIndex =
            (this.currentIndex + 1) % this.keys.length;

        return key;
    }

    get size(): number {
        return this.keys.length;
    }
}