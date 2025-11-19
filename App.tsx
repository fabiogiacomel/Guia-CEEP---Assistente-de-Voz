import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Mic, MicOff, Activity, School } from 'lucide-react';
import { MODEL_NAME, SYSTEM_INSTRUCTION } from './constants';
import { createBlob, decode, decodeAudioData } from './utils/audioUtils';
import AudioVisualizer from './components/AudioVisualizer';

const App: React.FC = () => {
  const [connected, setConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live'>('idle');

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  
  // Stream Ref
  const streamRef = useRef<MediaStream | null>(null);
  
  // Playback Queue Management
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Session Management
  const sessionRef = useRef<Promise<any> | null>(null);

  const disconnect = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (inputSourceRef.current) {
      inputSourceRef.current.disconnect();
      inputSourceRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    // Clear audio queue
    audioSourcesRef.current.forEach(source => {
        try { source.stop(); } catch (e) { /* ignore */ }
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    sessionRef.current = null;

    setConnected(false);
    setIsSpeaking(false);
    setStatus('idle');
  };

  const connect = async () => {
    try {
      setStatus('connecting');
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // Initialize Audio Contexts
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Setup Analyser for Visualization (Input)
      const analyser = inputAudioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      // Setup Microphone Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const source = inputAudioContextRef.current.createMediaStreamSource(stream);
      inputSourceRef.current = source;

      // Connect Input -> Analyser
      source.connect(analyser);

      // Connect Live Session
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, // Kore has a nice neutral/deep tone
          },
        },
        callbacks: {
          onopen: () => {
            console.log('Gemini Live Session Connected');
            setConnected(true);
            setStatus('live');

            // Start Input Processing
            if (!inputAudioContextRef.current || !inputSourceRef.current) return;
            
            // Using ScriptProcessor as per Gemini API docs (AudioWorklet is standard but requires separate file/setup not ideal for this single-file task constraints)
            const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                
                sessionPromise.then(session => {
                    session.sendRealtimeInput({ media: pcmBlob });
                });
            };

            inputSourceRef.current.connect(processor);
            processor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle interruptions
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
                console.log('Interrupted');
                setIsSpeaking(false);
                audioSourcesRef.current.forEach(source => {
                    try { source.stop(); } catch (e) {}
                });
                audioSourcesRef.current.clear();
                nextStartTimeRef.current = 0;
                return;
            }

            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            
            if (base64Audio && outputAudioContextRef.current) {
                setIsSpeaking(true);
                const ctx = outputAudioContextRef.current;
                
                try {
                    const audioBuffer = await decodeAudioData(
                        decode(base64Audio),
                        ctx,
                        24000,
                        1
                    );

                    nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                    
                    const source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(ctx.destination);
                    
                    source.addEventListener('ended', () => {
                        audioSourcesRef.current.delete(source);
                        if (audioSourcesRef.current.size === 0) {
                            setIsSpeaking(false);
                        }
                    });

                    source.start(nextStartTimeRef.current);
                    audioSourcesRef.current.add(source);
                    
                    nextStartTimeRef.current += audioBuffer.duration;

                } catch (decodeError) {
                    console.error("Audio decode error", decodeError);
                }
            }
          },
          onclose: () => {
            console.log('Session closed');
            disconnect();
          },
          onerror: (err) => {
            console.error('Session error', err);
            setError("Erro na conexão com o assistente.");
            disconnect();
          }
        }
      });
      
      sessionRef.current = sessionPromise;

    } catch (e: any) {
      console.error(e);
      setError(e.message || "Não foi possível iniciar o microfone.");
      setStatus('idle');
    }
  };

  // Ensure cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 flex flex-col items-center justify-center p-6 relative overflow-hidden">
        
        {/* Background Elements */}
        <div className="absolute top-[-10%] right-[-10%] w-96 h-96 bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-[-10%] left-[-10%] w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl pointer-events-none" />

        {/* Main Card */}
        <div className="relative z-10 w-full max-w-md bg-slate-800/50 backdrop-blur-xl border border-slate-700 rounded-2xl p-8 shadow-2xl flex flex-col gap-6">
            
            {/* Header */}
            <div className="text-center space-y-2">
                <div className="flex justify-center mb-4">
                    <div className="p-4 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full shadow-lg shadow-blue-500/30">
                         <School className="w-10 h-10 text-white" />
                    </div>
                </div>
                <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                    Guia CEEP
                </h1>
                <p className="text-sm text-slate-400">
                    Pedro Boaretto Neto
                </p>
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-700/50 border border-slate-600 text-xs font-medium text-slate-300 mt-2">
                    {status === 'idle' && <span className="w-2 h-2 rounded-full bg-slate-500" />}
                    {status === 'connecting' && <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />}
                    {status === 'live' && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                    {status === 'idle' ? 'Desconectado' : status === 'connecting' ? 'Conectando...' : 'Online e Ouvindo'}
                </div>
            </div>

            {/* Visualizer Area */}
            <div className="relative">
                <AudioVisualizer isActive={status === 'live'} analyser={analyserRef.current} />
                
                {/* Speaking Indicator Overlay */}
                {isSpeaking && (
                    <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/40 backdrop-blur-sm px-2 py-1 rounded text-xs text-blue-300 font-mono border border-blue-500/30">
                        <Activity className="w-3 h-3 animate-bounce" />
                        Guia Falando
                    </div>
                )}
            </div>

            {/* Controls */}
            <div className="flex justify-center mt-2">
                {!connected ? (
                    <button 
                        onClick={connect}
                        disabled={status === 'connecting'}
                        className="group relative flex items-center justify-center gap-3 w-full py-4 px-6 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded-xl font-semibold transition-all duration-200 shadow-lg shadow-blue-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Mic className="w-5 h-5 group-hover:scale-110 transition-transform" />
                        <span>Iniciar Conversa</span>
                    </button>
                ) : (
                    <button 
                        onClick={disconnect}
                        className="group flex items-center justify-center gap-3 w-full py-4 px-6 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/50 rounded-xl font-semibold transition-all duration-200"
                    >
                        <MicOff className="w-5 h-5 group-hover:scale-110 transition-transform" />
                        <span>Encerrar</span>
                    </button>
                )}
            </div>

            {/* Instructions / Footer */}
            <div className="text-center space-y-3 pt-2 border-t border-slate-700/50">
                {error ? (
                    <p className="text-red-400 text-sm bg-red-400/10 p-2 rounded border border-red-400/20">{error}</p>
                ) : (
                    <p className="text-slate-500 text-xs leading-relaxed">
                        Pergunte sobre nossos cursos: Design de Interiores, Informática, Enfermagem e mais. Clique em iniciar e fale naturalmente.
                    </p>
                )}
            </div>
        </div>
        
        <div className="absolute bottom-4 text-slate-600 text-xs">
            Powered by Gemini Live API
        </div>
    </div>
  );
};

export default App;