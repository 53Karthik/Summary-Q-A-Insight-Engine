import React, { useState, useCallback, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as pdfjsLib from 'pdfjs-dist';

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, collection, addDoc, query, orderBy, serverTimestamp } from 'firebase/firestore';

// --- PDF WORKER SETUP (STABLE CDN) ---
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

// --- API CONFIGURATION ---
const API_URL = "http://localhost:3001/api/summarize";

const fetchWithRetry = async (url, options, maxRetries = 5) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 429 && i < maxRetries - 1) {
                const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API call failed: ${response.status} ${response.statusText}. Details: ${errorText}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.error(`Attempt ${i + 1} failed:`, error);
        }
    }
};

const App = () => {
    const [pdfText, setPdfText] = useState('');
    const [question, setQuestion] = useState('');
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [userId, setUserId] = useState(null);
    const [history, setHistory] = useState([]); // For autocomplete

    const fileInputRef = useRef(null);
    const [db, setDb] = useState(null);

    // --- FIREBASE INIT ---
    useEffect(() => {
        const configString = typeof __firebase_config !== 'undefined' ? __firebase_config : null;
        if (configString) {
            try {
                const firebaseConfig = JSON.parse(configString);
                const app = initializeApp(firebaseConfig);
                const authInstance = getAuth(app);
                const dbInstance = getFirestore(app);

                setDb(dbInstance);

                const unsubscribe = onAuthStateChanged(authInstance, (user) => {
                    if (user) setUserId(user.uid);
                    else signInAnonymously(authInstance).catch(console.error);
                });

                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    signInWithCustomToken(authInstance, __initial_auth_token).catch(console.error);
                }
                return () => unsubscribe();
            } catch (e) { console.error(e); }
        }
    }, []);

    // --- LOAD HISTORY FOR AUTOCOMPLETE ---
    useEffect(() => {
        if (!db || !userId) { setHistory([]); return; }
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const historyRef = collection(db, 'artifacts', appId, 'users', userId, 'history');
        const q = query(historyRef, orderBy('createdAt', 'desc'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            // Get list of questions for autocomplete
            const items = snapshot.docs.map(doc => doc.data());
            setHistory(items);
        });
        return () => unsubscribe();
    }, [db, userId]);

    // --- PDF LOGIC ---
    const extractTextFromPDF = async (file) => {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item) => item.str).join(' ');
            fullText += `\n--- Page ${i} ---\n${pageText}`;
        }
        return fullText;
    };

    const handleFileChange = useCallback(async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setSummary(null);
        setError(null);
        setLoading(true);
        setPdfText("Extracting text from PDF... please wait.");
        try {
            const extractedText = await extractTextFromPDF(file);
            setPdfText(extractedText);
        } catch (err) {
            setError("Failed to extract text. Is this a scanned PDF?");
            setPdfText("");
        } finally {
            setLoading(false);
        }
    }, []);

    const handleFormSubmit = async (e) => {
        e.preventDefault();
        await queryDocument();
    };

    const queryDocument = useCallback(async () => {
        if (!pdfText.trim() && !question.trim()) {
            setError("Please upload a PDF, paste text, or ask a question.");
            return;
        }
        setLoading(true);
        setError(null);
        setSummary(null);

        const frontendPayload = { documentText: pdfText, question: question, responseFormat: 'text' };

        try {
            const response = await fetchWithRetry(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(frontendPayload),
            });
            const result = await response.json();

            if (result.summary) {
                // Just store text content
                setSummary({ content: result.summary });

                if (db && userId) {
                    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
                    addDoc(collection(db, 'artifacts', appId, 'users', userId, 'history'), {
                        question: question || "Insight",
                        answer: result.summary,
                        createdAt: serverTimestamp()
                    });
                }
            } else {
                setError(result.error || "Backend response was empty.");
            }
        } catch (err) {
            setError(`Failed to connect to backend (Port 3001).`);
        } finally {
            setLoading(false);
        }
    }, [pdfText, question, db, userId]);

    // Get unique questions for autocomplete list
    const uniqueQuestions = [...new Set(history.map(item => item.question).filter(Boolean))];

    return (
        <div className="min-h-screen bg-gray-50 font-sans text-gray-800">
            <div className="max-w-4xl mx-auto p-4 sm:p-8">
                <header className="mb-8 text-center">
                    <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 tracking-tight mb-2">Summary | Q&A | Insight Engine</h1>
                    <p className="text-gray-500">Upload a PDF or ask a question to generate insights.</p>
                </header>

                <div className="bg-white p-6 rounded-xl shadow-lg border border-gray-200 mb-8">
                    <form onSubmit={handleFormSubmit}>
                        <div className="mb-4">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Upload PDF</label>
                            <input ref={fileInputRef} id="pdf-upload" type="file" accept="application/pdf" onChange={handleFileChange} className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-600 hover:file:bg-indigo-100 cursor-pointer" />
                        </div>

                        <div className="mt-6">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Extracted Document Text (Optional)</label>
                            <textarea rows={6} value={pdfText} onChange={(e) => setPdfText(e.target.value)} className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 transition duration-150 shadow-inner resize-none font-mono text-xs" placeholder="Upload a PDF or paste text here..." />
                        </div>

                        <div className="mt-6">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Ask Your Question (Optional)</label>
                            <input
                                type="text"
                                name="user-question"
                                list="history-options"
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 transition duration-150 shadow-inner"
                                placeholder="Enter your question here..."
                                autoComplete="on"
                            />
                            <datalist id="history-options">
                                {uniqueQuestions.map((q, idx) => (
                                    <option key={idx} value={q} />
                                ))}
                            </datalist>
                        </div>

                        <button type="submit" disabled={loading || (!pdfText.trim() && !question.trim())} className={`mt-6 w-full sm:w-auto px-8 py-3 text-lg font-medium rounded-xl shadow-md transition duration-200 flex items-center justify-center mx-auto ${loading || (!pdfText.trim() && !question.trim()) ? 'bg-gray-400 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-lg'}`}>
                            {loading && <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>}
                            {loading ? 'Processing...' : 'Get Summary/Insight'}
                        </button>
                    </form>
                    {error && <div className="mt-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-lg text-sm text-center"><span className="font-semibold">Error:</span> {error}</div>}
                </div>

                {summary && (
                    <div className="bg-white p-6 rounded-xl shadow-lg border-2 border-indigo-200 max-w-4xl mx-auto">
                        <div className="prose prose-indigo max-w-none text-gray-700 leading-relaxed summary-output">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {typeof summary.content === 'string' ? summary.content : JSON.stringify(summary.content, null, 2)}
                            </ReactMarkdown>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default App;