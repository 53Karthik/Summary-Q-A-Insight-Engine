const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config(); 
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = 3001; 

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error("FATAL: GEMINI_API_KEY not found in .env file. Check your .env setup.");
    process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

app.use(cors({ origin: 'http://localhost:5173' })); 
app.use(bodyParser.json({ limit: '5mb' })); 

app.post('/api/summarize', async (req, res) => {
    const { documentText, question, responseFormat } = req.body;

    const MAX_CONTEXT_LENGTH = 100000;
    let textToProcess = documentText || ""; 

    if (textToProcess.length > MAX_CONTEXT_LENGTH * 4) {
        return res.status(400).json({ error: "Document is too long. Please implement chunking on the backend." });
    }

    let systemPrompt;
    let userQuery;
    let generationConfig = {};

    // --- MODE SELECTION ---
    if (responseFormat === 'json') {
        // JSON Extraction Mode (The New USP)
        systemPrompt = `You are a Data Extraction Engine. Analyze the provided document text and output strictly valid JSON. 
        Do not include Markdown formatting (like \`\`\`json). 
        Extract the following fields:
        - "key_metrics": A list of numerical data points, dates, or financial figures found.
        - "action_items": A list of clear next steps or requirements.
        - "sentiment": One word (Positive, Neutral, or Negative).
        - "summary": A concise 2-sentence summary of the content.
        
        If specific data is missing, use empty arrays or "N/A".`;
        
        userQuery = `DOCUMENT CONTENT:\n\n---\n${textToProcess}\n---\n\nContext/Focus Area (Optional): ${question}`;
        
        // Force JSON output structure
        generationConfig = {
            responseMimeType: "application/json" 
        };

    } else {
        // Standard Q&A Mode
        if (textToProcess.trim().length > 0) {
            systemPrompt = "You are a specialized Document Insight Engine. Answer the user's QUESTION based ONLY on the provided DOCUMENT CONTENT. Use Markdown formatting.";
            userQuery = `DOCUMENT CONTENT:\n\n---\n${textToProcess}\n---\n\nUSER QUESTION: ${question}`;
        } else {
            systemPrompt = "You are a helpful AI assistant. Answer the user's question clearly and concisely using Markdown formatting.";
            userQuery = `USER QUESTION: ${question}`;
        }
    }

    try {
        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            model: "gemini-2.5-flash-preview-09-2025", 
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
            generationConfig: generationConfig 
        };

        const response = await ai.models.generateContent(payload);
        const generatedText = response.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (generatedText) {
            res.json({ summary: generatedText });
        } else {
            res.status(500).json({ error: "Gemini API returned an unexpected empty response." });
        }

    } catch (error) {
        console.error("Error during Gemini API call:", error);
        res.status(500).json({ error: "Internal server error during AI processing." });
    }
});

app.listen(PORT, () => {
    console.log(`Backend proxy running securely on http://localhost:${PORT}`);
});