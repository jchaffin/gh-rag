"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
// scripts/ask.ts
var dotenv_1 = require("dotenv");
var path_1 = require("path");
var pinecone_1 = require("@pinecone-database/pinecone");
(0, dotenv_1.config)({ path: (0, path_1.resolve)(process.cwd(), ".env.local"), override: true });
var src_1 = require("../src");
function mask(v) {
    return v ? v.slice(0, 6) + "…" + v.slice(-4) : "";
}
console.log("OPENAI_API_KEY:", mask(process.env.OPENAI_API_KEY));
console.log("PINECONE_API_KEY:", mask(process.env.PINECONE_API_KEY));
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, OPENAI_API_KEY, PINECONE_API_KEY, _b, PINECONE_INDEX, GITHUB_TOKEN, _c, QUESTION, pc, index, rag, res;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _a = process.env, OPENAI_API_KEY = _a.OPENAI_API_KEY, PINECONE_API_KEY = _a.PINECONE_API_KEY, _b = _a.PINECONE_INDEX, PINECONE_INDEX = _b === void 0 ? "repo-chunks" : _b, GITHUB_TOKEN = _a.GITHUB_TOKEN, _c = _a.QUESTION, QUESTION = _c === void 0 ? "Tell me about the API integrations" : _c;
                    if (!OPENAI_API_KEY || !PINECONE_API_KEY || !PINECONE_INDEX) {
                        console.error("Missing env. Need OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX");
                        process.exit(1);
                    }
                    pc = new pinecone_1.Pinecone({ apiKey: PINECONE_API_KEY });
                    index = pc.index(PINECONE_INDEX);
                    rag = (0, src_1.createGhRag)({
                        openaiApiKey: OPENAI_API_KEY,
                        githubToken: GITHUB_TOKEN,
                        pine: { index: index },
                    });
                    console.time("answer");
                    return [4 /*yield*/, rag.answer({
                            repo: "JobLaunch",
                            question: QUESTION,
                        })];
                case 1:
                    res = _d.sent();
                    console.timeEnd("answer");
                    console.log("\n=== ANSWER ===\n");
                    console.log(res.text);
                    return [2 /*return*/];
            }
        });
    });
}
main().catch(function (e) {
    console.error(e);
    process.exit(1);
});
