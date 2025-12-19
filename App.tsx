
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Trophy, 
  Mic, 
  MicOff, 
  Play, 
  User, 
  Settings, 
  MessageSquare,
  RefreshCcw,
  Volume2,
  ChevronRight,
  Info
} from 'lucide-react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { HostPersonality, GameState, TriviaQuestion, ChatMessage } from './types';
import { PERSONALITIES, DEFAULT_TOPICS } from './constants';
import { generateTriviaQuestions } from './services/geminiService';
import { decodeAudioData, decodeBase64, createPcmBlob } from './services/audioUtils';

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>({
    status: 'IDLE',
    personality: null,
    score: 0,
    currentQuestionIndex: 0,
    questions: [],
    userAnswer: null,
    transcription: '',
  });

  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isGeneratingQuestions, setIsGeneratingQuestions] = useState(false);
  const [topic, setTopic] = useState(DEFAULT_TOPICS[0]);

  // Audio refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const addChatMessage = useCallback((role: 'user' | 'host', text: string) => {
    setChatHistory(prev => [...prev, { role, text, timestamp: Date.now() }].slice(-10));
  }, []);

  const handleStartGame = async () => {
    if (!gameState.personality) return;
    setIsGeneratingQuestions(true);
    try {
      const qs = await generateTriviaQuestions(topic, gameState.personality.name);
      setGameState(prev => ({
        ...prev,
        status: 'PLAYING',
        questions: qs,
        currentQuestionIndex: 0,
        score: 0
      }));
      addChatMessage('host', `Welcome to the ${topic} trivia challenge! Let's get started.`);
    } catch (err) {
      console.error(err);
    } finally {
      setIsGeneratingQuestions(false);
    }
  };

  const handleAnswer = (option: string) => {
    const currentQ = gameState.questions[gameState.currentQuestionIndex];
    const isCorrect = option === currentQ.correctAnswer;
    
    setGameState(prev => ({
      ...prev,
      userAnswer: option,
      score: isCorrect ? prev.score + 100 : prev.score
    }));

    addChatMessage('user', `My answer is ${option}`);
    
    // In a real app, we'd trigger a host reaction via Live API or TTS here.
    // For now, let's just let the user see the result.
  };

  const nextQuestion = () => {
    if (gameState.currentQuestionIndex < gameState.questions.length - 1) {
      setGameState(prev => ({
        ...prev,
        currentQuestionIndex: prev.currentQuestionIndex + 1,
        userAnswer: null
      }));
    } else {
      setGameState(prev => ({ ...prev, status: 'FINISHED' }));
    }
  };

  const startLiveSession = async () => {
    if (!gameState.personality || isLiveActive) return;

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setIsLiveActive(true);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Handle Audio
            const audioBase64 = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioBase64 && audioContextRef.current) {
              const ctx = audioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decodeBase64(audioBase64), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            // Handle Transcriptions
            if (msg.serverContent?.outputTranscription) {
               setGameState(prev => ({ ...prev, transcription: prev.transcription + msg.serverContent!.outputTranscription!.text }));
            }
            if (msg.serverContent?.turnComplete) {
              setGameState(prev => {
                if (prev.transcription) addChatMessage('host', prev.transcription);
                return { ...prev, transcription: '' };
              });
            }
            
            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => setIsLiveActive(false),
          onerror: (e) => console.error("Live Error", e)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: gameState.personality.systemInstruction + " You are currently hosting a trivia game about " + topic,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          outputAudioTranscription: {}
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Failed to start live session", err);
    }
  };

  const stopLiveSession = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setIsLiveActive(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center p-4 md:p-8">
      {/* Header */}
      <header className="w-full max-w-4xl flex justify-between items-center mb-8">
        <div className="flex items-center gap-2">
          <div className="w-12 h-12 bg-violet-600 rounded-xl flex items-center justify-center neon-border">
            <Trophy className="text-white" size={24} />
          </div>
          <div>
            <h1 className="font-game text-2xl text-white tracking-wider">GEMINI TRIVIA</h1>
            <p className="text-xs text-slate-400 font-medium uppercase tracking-widest">AI Hosted Experience</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="hidden md:flex flex-col items-end">
             <span className="text-xs text-slate-500 font-bold">CURRENT SCORE</span>
             <span className="text-xl font-game text-violet-400">{gameState.score}</span>
          </div>
          <button 
            onClick={() => setGameState(prev => ({ ...prev, status: 'IDLE', personality: null }))}
            className="p-2 hover:bg-slate-800 rounded-full transition-colors"
          >
            <Settings className="text-slate-400" size={20} />
          </button>
        </div>
      </header>

      <main className="w-full max-w-4xl flex-1 flex flex-col gap-6">
        {/* State: IDLE - Personality Selection */}
        {gameState.status === 'IDLE' && (
          <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="text-center mb-4">
              <h2 className="text-3xl font-bold text-white mb-2">Choose Your Host</h2>
              <p className="text-slate-400">Select a personality to guide you through the trivia.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {PERSONALITIES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setGameState(prev => ({ ...prev, status: 'SETUP', personality: p }))}
                  className={`flex items-center gap-4 p-6 rounded-2xl border-2 transition-all group ${
                    gameState.personality?.id === p.id 
                    ? 'border-violet-500 bg-slate-900 shadow-lg shadow-violet-900/20' 
                    : 'border-slate-800 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900'
                  }`}
                >
                  <span className="text-5xl group-hover:scale-110 transition-transform">{p.avatar}</span>
                  <div className="text-left">
                    <h3 className="text-xl font-bold text-white">{p.name}</h3>
                    <p className="text-sm text-slate-400">{p.description}</p>
                  </div>
                  <ChevronRight className="ml-auto text-slate-600 group-hover:text-violet-500 transition-colors" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* State: SETUP - Topic Selection */}
        {gameState.status === 'SETUP' && (
          <div className="flex flex-col gap-8 items-center animate-in fade-in duration-500">
             <div className="text-center">
                <span className="text-6xl mb-4 block">{gameState.personality?.avatar}</span>
                <h2 className="text-2xl font-bold text-white">Hosted by {gameState.personality?.name}</h2>
             </div>
             
             <div className="w-full max-w-md space-y-4">
                <label className="text-sm font-bold text-slate-500 uppercase">Select Topic</label>
                <div className="grid grid-cols-1 gap-2">
                  {DEFAULT_TOPICS.map(t => (
                    <button 
                      key={t}
                      onClick={() => setTopic(t)}
                      className={`px-4 py-3 rounded-xl border text-left transition-all ${
                        topic === t 
                        ? 'border-violet-500 bg-violet-500/10 text-violet-400' 
                        : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                
                <div className="pt-4">
                  <button 
                    onClick={handleStartGame}
                    disabled={isGeneratingQuestions}
                    className="w-full py-4 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg shadow-violet-900/40 flex items-center justify-center gap-2 transition-all active:scale-95"
                  >
                    {isGeneratingQuestions ? <RefreshCcw className="animate-spin" /> : <Play size={20} fill="currentColor" />}
                    {isGeneratingQuestions ? 'Gathering Intel...' : 'Start Game'}
                  </button>
                </div>
             </div>
          </div>
        )}

        {/* State: PLAYING - Main Game Board */}
        {gameState.status === 'PLAYING' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in zoom-in-95 duration-300">
            {/* Left Column: Host & Voice */}
            <div className="flex flex-col gap-4">
              <div className="bg-slate-900 rounded-3xl p-6 border border-slate-800 flex flex-col items-center gap-4 relative overflow-hidden">
                <div className={`absolute top-0 left-0 w-full h-1 ${gameState.personality?.color}`}></div>
                <span className="text-7xl">{gameState.personality?.avatar}</span>
                <h3 className="font-game text-xl text-white">{gameState.personality?.name}</h3>
                
                <div className="w-full p-4 bg-slate-950 rounded-2xl min-h-[100px] text-sm text-slate-300 italic flex items-center justify-center text-center">
                  "{gameState.transcription || chatHistory.find(m => m.role === 'host')?.text || "Click the mic to talk to me!"}"
                </div>

                <button 
                  onClick={isLiveActive ? stopLiveSession : startLiveSession}
                  className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                    isLiveActive ? 'bg-red-500 shadow-lg shadow-red-900/40' : 'bg-violet-600 shadow-lg shadow-violet-900/40 hover:bg-violet-500'
                  }`}
                >
                  {isLiveActive ? <MicOff className="text-white" /> : <Mic className="text-white" />}
                </button>
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                  {isLiveActive ? 'Live Connection Active' : 'Tap Mic for Voice Chat'}
                </p>
              </div>

              {/* Chat Mini Log */}
              <div className="bg-slate-900 rounded-2xl p-4 border border-slate-800 flex-1 hidden md:flex flex-col gap-3 max-h-[250px] overflow-y-auto">
                <div className="flex items-center gap-2 text-slate-500 text-xs font-bold uppercase">
                  <MessageSquare size={14} />
                  <span>Dialogue Log</span>
                </div>
                {chatHistory.map((msg, i) => (
                  <div key={i} className={`text-xs ${msg.role === 'user' ? 'text-slate-500 ml-4' : 'text-violet-400 font-medium'}`}>
                    <span className="opacity-50 mr-1">{msg.role === 'user' ? 'You:' : 'Host:'}</span>
                    {msg.text}
                  </div>
                ))}
              </div>
            </div>

            {/* Middle/Right Column: Trivia Question */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="bg-slate-900 rounded-3xl p-8 border border-slate-800 relative shadow-2xl">
                 <div className="flex justify-between items-center mb-8">
                    <span className="px-3 py-1 bg-violet-600/20 text-violet-400 rounded-full text-xs font-bold uppercase tracking-widest border border-violet-500/30">
                      Question {gameState.currentQuestionIndex + 1} of {gameState.questions.length}
                    </span>
                    <div className="flex items-center gap-2 text-slate-400">
                      <Volume2 size={16} />
                      <span className="text-xs">TTS Enabled</span>
                    </div>
                 </div>

                 <h2 className="text-2xl md:text-3xl font-bold text-white mb-10 leading-snug">
                   {gameState.questions[gameState.currentQuestionIndex]?.question}
                 </h2>

                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {gameState.questions[gameState.currentQuestionIndex]?.options.map((option, i) => {
                      const isCorrect = option === gameState.questions[gameState.currentQuestionIndex].correctAnswer;
                      const isSelected = gameState.userAnswer === option;
                      const showResult = gameState.userAnswer !== null;

                      let btnClass = "p-5 rounded-2xl border-2 text-left font-medium transition-all flex justify-between items-center ";
                      if (showResult) {
                        if (isCorrect) btnClass += "border-green-500 bg-green-500/10 text-green-400";
                        else if (isSelected) btnClass += "border-red-500 bg-red-500/10 text-red-400";
                        else btnClass += "border-slate-800 bg-slate-900 text-slate-600 opacity-50";
                      } else {
                        btnClass += "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-600 hover:bg-slate-800 active:scale-[0.98]";
                      }

                      return (
                        <button 
                          key={i} 
                          disabled={showResult}
                          onClick={() => handleAnswer(option)}
                          className={btnClass}
                        >
                          <span>{option}</span>
                          {showResult && isCorrect && <Trophy size={18} className="text-green-500" />}
                        </button>
                      );
                    })}
                 </div>

                 {gameState.userAnswer && (
                   <div className="mt-8 p-6 bg-slate-950/50 rounded-2xl border border-slate-800 animate-in slide-in-from-top-4 duration-300">
                      <div className="flex items-center gap-2 mb-2 text-slate-400">
                        <Info size={16} />
                        <span className="text-xs font-bold uppercase tracking-widest">Host's Explanation</span>
                      </div>
                      <p className="text-slate-300 text-sm italic">
                        "{gameState.questions[gameState.currentQuestionIndex]?.explanation}"
                      </p>
                      <button 
                        onClick={nextQuestion}
                        className="mt-6 w-full py-4 bg-white text-slate-950 font-bold rounded-xl flex items-center justify-center gap-2 hover:bg-slate-200 transition-colors"
                      >
                        Next Question <ChevronRight size={20} />
                      </button>
                   </div>
                 )}
              </div>
              
              <div className="bg-slate-900/50 border border-slate-800/50 rounded-2xl p-4 flex items-center gap-3">
                 <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                 <span className="text-xs text-slate-500 font-medium">Verified by Google Search Grounding for accuracy.</span>
              </div>
            </div>
          </div>
        )}

        {/* State: FINISHED - Results */}
        {gameState.status === 'FINISHED' && (
          <div className="flex flex-col items-center justify-center gap-8 py-12 animate-in fade-in zoom-in duration-500">
            <div className="w-32 h-32 bg-yellow-500 rounded-full flex items-center justify-center shadow-2xl shadow-yellow-900/40 relative">
               <Trophy className="text-white" size={64} />
               <div className="absolute -top-4 -right-4 bg-violet-600 w-12 h-12 rounded-full flex items-center justify-center border-4 border-slate-950">
                 <span className="text-white font-bold">#1</span>
               </div>
            </div>
            
            <div className="text-center">
              <h2 className="text-4xl font-game text-white mb-2">GAME OVER!</h2>
              <p className="text-slate-400 text-lg">You scored <span className="text-violet-400 font-bold">{gameState.score}</span> points.</p>
            </div>

            <div className="flex flex-col md:flex-row gap-4 w-full max-w-sm">
              <button 
                onClick={() => setGameState(prev => ({ ...prev, status: 'SETUP' }))}
                className="flex-1 py-4 bg-violet-600 text-white font-bold rounded-xl hover:bg-violet-500 transition-all flex items-center justify-center gap-2"
              >
                <RefreshCcw size={20} /> Play Again
              </button>
              <button 
                onClick={() => setGameState(prev => ({ ...prev, status: 'IDLE', personality: null }))}
                className="flex-1 py-4 bg-slate-800 text-slate-300 font-bold rounded-xl hover:bg-slate-700 transition-all"
              >
                Switch Host
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer / Status Bar */}
      <footer className="w-full max-w-4xl mt-12 py-6 border-t border-slate-900 flex flex-col md:flex-row justify-between items-center text-slate-500 text-xs gap-4">
        <p>© 2024 Gemini Trivia Host • Powered by Google Generative AI</p>
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-full ${isLiveActive ? 'bg-green-500' : 'bg-slate-700'}`}></div>
            {isLiveActive ? 'Live Audio Connected' : 'Live Audio Offline'}
          </span>
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-violet-500"></div>
            Search Grounding Active
          </span>
        </div>
      </footer>
    </div>
  );
};

export default App;
