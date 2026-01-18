// Audio Lab - Application Logic

// --- Constants & State ---
let audioCtx;
let originalBuffer = null;
let sourceNode = null;
let isPlaying = false;
let startTime = 0;
let pauseTime = 0;
let playbackRate = 1.0;

// Effect Nodes (State holders for Live Preview)
let nodes = {};

// UI Elements
const fileInput = document.getElementById('file-input');
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');
const timeDisplay = document.getElementById('time-display');
const loadingOverlay = document.getElementById('loading-overlay');

// Effect Sliders
const sliders = {
    bass: document.getElementById('bass-slider'),
    bitcrusher: document.getElementById('bitcrusher-slider'),
    corrupter: document.getElementById('corrupter-slider'),
    distortion: document.getElementById('distortion-slider'),
    echo: document.getElementById('echo-slider'),
    reverb: document.getElementById('reverb-slider'),
    robotic: document.getElementById('robotic-slider'),
    shallow: document.getElementById('shallow-slider'),
    ambient: document.getElementById('ambient-slider')
};

// --- Initialization ---

function initAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// --- Event Listeners ---

fileInput.addEventListener('change', handleFileUpload);
playBtn.addEventListener('click', togglePlayback);
stopBtn.addEventListener('click', stopPlayback);

// Attach slider listeners
for (const [key, slider] of Object.entries(sliders)) {
    slider.addEventListener('input', (e) => {
        // Update value text
        slider.nextElementSibling.innerText = slider.value + '%';
        // Update audio effect
        // We update the live preview nodes
        if (Object.keys(nodes).length > 0) {
             updateEffectParams(key, parseFloat(slider.value), nodes);
        }
    });
}

document.getElementById('download-btn').addEventListener('click', handleDownload);

// --- File Handling ---

async function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    initAudioContext();
    showLoading(true);

    try {
        const arrayBuffer = await file.arrayBuffer();
        originalBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        // Enable controls
        document.getElementById('player-section').classList.remove('disabled');
        document.getElementById('effects-section').classList.remove('disabled');
        document.getElementById('download-section').classList.remove('disabled');

        // Reset playback
        stopPlayback();

        console.log("File loaded:", file.name);
    } catch (err) {
        console.error("Error loading file:", err);
        alert("Error loading audio file.");
    } finally {
        showLoading(false);
    }
}

// --- Audio Graph Construction ---

function createEffectChain(ctx, source, destination, targetNodesObj) {
    // 1. Bitcrusher
    // ScriptProcessor logic must be duplicated carefully if offline?
    // Note: ScriptProcessor is main-thread only. OfflineAudioContext might not support it fully in all browsers
    // or run it slower. However, standard spec says it should work.

    const bitcrusher = ctx.createScriptProcessor(4096, 2, 2);
    bitcrusher.channelState = [ {phaser:0, last:0}, {phaser:0, last:0} ];
    bitcrusher.params = { bits: 16, normfreq: 1.0 };

    bitcrusher.onaudioprocess = function(e) {
        const input = e.inputBuffer;
        const output = e.outputBuffer;

        // Optimization: Bypass if bits are high (clean)
        if (bitcrusher.params.bits >= 16) {
            for (let channel = 0; channel < output.numberOfChannels; channel++) {
                 output.getChannelData(channel).set(input.getChannelData(channel));
            }
            return;
        }

        const step = Math.pow(0.5, bitcrusher.params.bits);
        const invStep = 1.0 / step;
        const normfreq = bitcrusher.params.normfreq;

        for (let channel = 0; channel < output.numberOfChannels; channel++) {
            const inputData = input.getChannelData(channel);
            const outputData = output.getChannelData(channel);
            const state = bitcrusher.channelState[channel];

            for (let i = 0; i < inputData.length; i++) {
                state.phaser += normfreq;
                if (state.phaser >= 1.0) {
                    state.phaser -= 1.0;
                    state.last = step * Math.floor(inputData[i] * invStep + 0.5);
                }
                outputData[i] = state.last;
            }
        }
    };

    // 2. Corrupter
    const corrupter = ctx.createScriptProcessor(4096, 2, 2);
    // Circular buffer ~1 sec (or 2)
    const memLen = ctx.sampleRate * 2;
    // We attach memory to the node so it persists
    corrupter.memory = [new Float32Array(memLen), new Float32Array(memLen)];
    corrupter.writePtr = 0;
    corrupter.glitchState = {
        mode: 'none',
        counter: 0,
        duration: 0,
        startPtr: 0
    };
    corrupter.params = { intensity: 0 };

    corrupter.onaudioprocess = function(e) {
        const input = e.inputBuffer;
        const output = e.outputBuffer;
        const intensity = corrupter.params.intensity;
        const state = corrupter.glitchState;
        const memory = corrupter.memory;

        // Optimization: Bypass if no intensity and not glitching
        if (intensity === 0 && state.mode === 'none') {
             for (let channel = 0; channel < output.numberOfChannels; channel++) {
                 output.getChannelData(channel).set(input.getChannelData(channel));
             }
             // Still need to update memory for seamless transition if intensity rises
             for (let i = 0; i < input.length; i++) {
                for (let ch = 0; ch < 2; ch++) {
                     if (input.numberOfChannels > ch) {
                        memory[ch][corrupter.writePtr] = input.getChannelData(ch)[i];
                     }
                }
                corrupter.writePtr = (corrupter.writePtr + 1) % memLen;
             }
             return;
        }

        for (let i = 0; i < input.length; i++) {
            // Write to memory
            for (let ch = 0; ch < 2; ch++) {
                 if (input.numberOfChannels > ch) {
                    memory[ch][corrupter.writePtr] = input.getChannelData(ch)[i];
                 }
            }

            if (state.counter > 0) {
                state.counter--;

                if (state.mode === 'stutter') {
                    const readIdx = (state.startPtr + (state.duration - state.counter)) % memLen;
                    for (let ch = 0; ch < 2; ch++) output.getChannelData(ch)[i] = memory[ch][readIdx];
                } else if (state.mode === 'reverse') {
                    let readIdx = state.startPtr - (state.duration - state.counter);
                    if (readIdx < 0) readIdx += memLen;
                    for (let ch = 0; ch < 2; ch++) output.getChannelData(ch)[i] = memory[ch][readIdx];
                } else if (state.mode === 'noise') {
                     for (let ch = 0; ch < 2; ch++) output.getChannelData(ch)[i] = (Math.random() * 2 - 1) * 0.5;
                }

                if (state.counter === 0) state.mode = 'none';

            } else {
                // Chance to start glitch
                let chance = 0;
                if (intensity > 0) chance = 0.00001 + (intensity * 0.0005);

                if (Math.random() < chance) {
                    const dur = Math.floor(Math.random() * ctx.sampleRate * 0.5);
                    state.duration = dur;
                    state.counter = dur;
                    state.startPtr = corrupter.writePtr;

                    const typeRoll = Math.random();
                    if (typeRoll < 0.33) state.mode = 'stutter';
                    else if (typeRoll < 0.66) state.mode = 'reverse';
                    else state.mode = 'noise';

                     for (let ch = 0; ch < 2; ch++) output.getChannelData(ch)[i] = memory[ch][state.startPtr];
                } else {
                    for (let ch = 0; ch < 2; ch++) output.getChannelData(ch)[i] = input.getChannelData(ch)[i];
                }
            }
            corrupter.writePtr = (corrupter.writePtr + 1) % memLen;
        }
    };

    // 3. Robotic (Ring Modulator)
    const roboticInput = ctx.createGain();
    const roboticOutput = ctx.createGain();

    const roboticDry = ctx.createGain();
    const roboticWet = ctx.createGain();
    const roboticOsc = ctx.createOscillator();

    roboticOsc.type = 'sine';
    roboticOsc.frequency.value = 50;
    roboticOsc.start();

    roboticInput.connect(roboticDry);
    roboticDry.connect(roboticOutput);

    const ringMod = ctx.createGain();
    ringMod.gain.value = 0;
    roboticInput.connect(ringMod);
    roboticOsc.connect(ringMod.gain);

    ringMod.connect(roboticWet);
    roboticWet.connect(roboticOutput);

    targetNodesObj.robotic = { dry: roboticDry, wet: roboticWet, osc: roboticOsc };

    // 4. Distortion
    const distortionNode = ctx.createWaveShaper();
    distortionNode.oversample = '4x';
    // curve set by updateParams

    // 5. Bass Boost (LowShelf)
    const bassNode = ctx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 200;
    bassNode.gain.value = 0;

    // 6. Shallow (HighPass)
    const shallowNode = ctx.createBiquadFilter();
    shallowNode.type = 'highpass';
    shallowNode.frequency.value = 10;
    shallowNode.Q.value = 1;

    // 7. Echo (Delay)
    const echoInput = ctx.createGain();
    const echoDelay = ctx.createDelay(1.0);
    const echoFeedback = ctx.createGain();
    const echoWet = ctx.createGain();
    const echoOutput = ctx.createGain();

    echoInput.connect(echoOutput); // Dry
    echoInput.connect(echoDelay);
    echoDelay.connect(echoFeedback);
    echoFeedback.connect(echoDelay);
    echoDelay.connect(echoWet);
    echoWet.connect(echoOutput);

    targetNodesObj.echo = { delay: echoDelay, feedback: echoFeedback, wet: echoWet };

    // 8. Reverb (Convolver)
    const reverbInput = ctx.createGain();
    const reverbConvolver = ctx.createConvolver();
    const reverbWet = ctx.createGain();
    const reverbOutput = ctx.createGain();

    reverbConvolver.buffer = createReverbImpulse(ctx, 2, 2);

    reverbInput.connect(reverbOutput); // Dry
    reverbInput.connect(reverbConvolver);
    reverbConvolver.connect(reverbWet);
    reverbWet.connect(reverbOutput);

    targetNodesObj.reverb = { wet: reverbWet };

    // 9. Master Gain
    const masterGain = ctx.createGain();

    // --- Chain Connections ---
    source.connect(bitcrusher);
    bitcrusher.connect(corrupter);
    corrupter.connect(roboticInput);
    roboticOutput.connect(distortionNode);
    distortionNode.connect(bassNode);
    bassNode.connect(shallowNode);
    shallowNode.connect(echoInput);
    echoOutput.connect(reverbInput);
    reverbOutput.connect(masterGain);
    masterGain.connect(destination);

    // Save references to update
    targetNodesObj.source = source; // Add source for playbackRate control
    targetNodesObj.bitcrusher = bitcrusher;
    targetNodesObj.corrupter = corrupter;
    targetNodesObj.distortion = distortionNode;
    targetNodesObj.bass = bassNode;
    targetNodesObj.shallow = shallowNode;
    targetNodesObj.master = masterGain;
}

// --- Helpers for Effects ---

function cleanupNodes() {
    if (nodes.master) {
        try {
            nodes.master.disconnect();
        } catch(e) {}
    }
    if (nodes.robotic && nodes.robotic.osc) {
        try {
            nodes.robotic.osc.stop();
        } catch(e) {}
    }
    nodes = {};
}

function makeDistortionCurve(amount) {
    if (amount === 0) return null;
    const k = amount * 2;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

function createReverbImpulse(ctx, duration, decay) {
    const rate = ctx.sampleRate;
    const length = rate * duration;
    const impulse = ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
        const n = i;
        const env = Math.pow(1 - n / length, decay);
        left[i] = (Math.random() * 2 - 1) * env;
        right[i] = (Math.random() * 2 - 1) * env;
    }
    return impulse;
}

function updateEffectParams(name, value, targetNodes) {
    const val = value / 100;

    switch (name) {
        case 'bass':
            if (targetNodes.bass) targetNodes.bass.gain.value = value * 0.3;
            break;
        case 'distortion':
            if (targetNodes.distortion) targetNodes.distortion.curve = makeDistortionCurve(value);
            break;
        case 'shallow':
             if (targetNodes.shallow) {
                 const freq = 10 * Math.pow(300, val);
                 targetNodes.shallow.frequency.value = freq;
            }
            break;
        case 'robotic':
            if (targetNodes.robotic) {
                targetNodes.robotic.dry.gain.value = 1 - val;
                targetNodes.robotic.wet.gain.value = val * 2;
                targetNodes.robotic.osc.frequency.value = 30 + (val * 470);
            }
            break;
        case 'echo':
            if (targetNodes.echo) {
                targetNodes.echo.delay.delayTime.value = 0.1 + (val * 0.4);
                targetNodes.echo.feedback.gain.value = val * 0.6;
                targetNodes.echo.wet.gain.value = val;
            }
            break;
        case 'reverb':
            if (targetNodes.reverb) {
                const ambVal = parseFloat(sliders.ambient.value) / 100;
                const totalReverb = Math.min(1.0, val + ambVal);
                targetNodes.reverb.wet.gain.value = totalReverb * 2;
            }
            break;
        case 'ambient':
            // Playback Rate
            const rate = 1.0 - (val * 0.5);
            if (targetNodes === nodes) {
                // Update global state for live preview
                playbackRate = rate;
            }
            if (targetNodes.source) {
                targetNodes.source.playbackRate.value = rate;
            }

            // Reverb interaction
            if (targetNodes.reverb) {
                const reverbSliderVal = parseFloat(sliders.reverb.value) / 100;
                const totalReverb = Math.min(1.0, reverbSliderVal + val);
                targetNodes.reverb.wet.gain.value = totalReverb * 2;
            }
            break;
        case 'bitcrusher':
            if (targetNodes.bitcrusher && targetNodes.bitcrusher.params) {
                targetNodes.bitcrusher.params.bits = 16 - (val * 12);
                targetNodes.bitcrusher.params.normfreq = 1.0 - (val * 0.9);
            }
            break;
        case 'corrupter':
            if (targetNodes.corrupter && targetNodes.corrupter.params) {
                targetNodes.corrupter.params.intensity = val;
            }
            break;
    }
}

// --- Playback Control ---

function togglePlayback() {
    if (!originalBuffer) return;
    initAudioContext();

    if (isPlaying) {
        stopSource();
        isPlaying = false;
        playBtn.innerText = '▶';
    } else {
        playSource(pauseTime);
        isPlaying = true;
        playBtn.innerText = '⏸';
    }
}

function stopPlayback() {
    if (!originalBuffer) return;
    stopSource();
    pauseTime = 0;
    isPlaying = false;
    playBtn.innerText = '▶';
    updateTimeDisplay();
}

function playSource(offset) {
    if (sourceNode) {
        sourceNode.disconnect();
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = originalBuffer;
    sourceNode.playbackRate.value = playbackRate;

    // Connect to Graph
    createEffectChain(audioCtx, sourceNode, audioCtx.destination, nodes);

    sourceNode.start(0, offset);
    startTime = audioCtx.currentTime - offset;

    sourceNode.onended = () => {
        if (isPlaying && (audioCtx.currentTime - startTime) >= sourceNode.buffer.duration / playbackRate - 0.1) {
             stopPlayback();
        }
    };

    requestAnimationFrame(updateTimeDisplay);
}

function stopSource() {
    if (sourceNode) {
        try {
            sourceNode.stop();
        } catch(e) {}
        pauseTime = (audioCtx.currentTime - startTime) * playbackRate;
        sourceNode.disconnect();
        sourceNode = null;
    }
    cleanupNodes();
}

function updateTimeDisplay() {
    if (!originalBuffer) return;

    let current = 0;
    const total = originalBuffer.duration;

    if (isPlaying) {
        current = (audioCtx.currentTime - startTime) * playbackRate;
        if (current > total) current = total;
        requestAnimationFrame(updateTimeDisplay);
    } else {
        current = pauseTime;
    }

    timeDisplay.innerText = formatTime(current) + " / " + formatTime(total);
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Export Logic ---

function handleDownload() {
    if (!originalBuffer) return;
    showLoading(true);
    // Defer to allow UI update
    setTimeout(() => {
        startOfflineRender();
    }, 100);
}

function startOfflineRender() {
    const rate = playbackRate;
    const duration = originalBuffer.duration / rate; // Adjusted duration

    const format = document.getElementById('export-format').value;
    const sampleRateStr = document.getElementById('export-rate').value;
    const targetSampleRate = parseInt(sampleRateStr);

    // Create Offline Context
    // Note: OfflineAudioContext duration is in seconds.
    // If playbackRate is 0.5 (slow), duration is double.

    const offlineCtx = new OfflineAudioContext(2, duration * targetSampleRate, targetSampleRate);

    const offlineSource = offlineCtx.createBufferSource();
    offlineSource.buffer = originalBuffer;
    offlineSource.playbackRate.value = rate;

    const offlineNodes = {};
    createEffectChain(offlineCtx, offlineSource, offlineCtx.destination, offlineNodes);

    // Apply current slider values
    for (const [key, slider] of Object.entries(sliders)) {
        updateEffectParams(key, parseFloat(slider.value), offlineNodes);
    }

    offlineSource.start(0);

    offlineCtx.startRendering().then(renderedBuffer => {
        if (format === 'mp3') {
            exportMp3(renderedBuffer);
        } else {
            exportWav(renderedBuffer);
        }
        showLoading(false);
    }).catch(err => {
        console.error("Rendering failed:", err);
        alert("Rendering failed. See console.");
        showLoading(false);
    });
}

function exportWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const samples = buffer.length;

    // Interleave
    const interleaved = new Float32Array(samples * numChannels);
    for (let i = 0; i < samples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            interleaved[i * numChannels + ch] = buffer.getChannelData(ch)[i];
        }
    }

    const wavBytes = encodeWAV(interleaved, numChannels, sampleRate);
    const blob = new Blob([wavBytes], { type: 'audio/wav' });
    triggerDownload(blob, 'audio_lab_export.wav');
}

function encodeWAV(samples, numChannels, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    /* RIFF identifier */
    writeString(view, 0, 'RIFF');
    /* RIFF chunk length */
    view.setUint32(4, 36 + samples.length * 2, true);
    /* RIFF type */
    writeString(view, 8, 'WAVE');
    /* format chunk identifier */
    writeString(view, 12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw) */
    view.setUint16(20, 1, true);
    /* channel count */
    view.setUint16(22, numChannels, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * 4, true); // Stereo 16bit = 4 bytes? No. numChannels * 2 bytes.
    // block align (channel count * bytes per sample)
    view.setUint16(32, numChannels * 2, true);
    /* bits per sample */
    view.setUint16(34, 16, true);
    /* data chunk identifier */
    writeString(view, 36, 'data');
    /* data chunk length */
    view.setUint32(40, samples.length * 2, true);

    floatTo16BitPCM(view, 44, samples);

    return view;
}

function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, input[i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        output.setInt16(offset, s, true);
    }
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function exportMp3(buffer) {
    if (typeof lamejs === 'undefined') {
        alert("MP3 Encoder (lamejs) not found. Downloading WAV instead.");
        exportWav(buffer);
        return;
    }

    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const samples = buffer.length;

    // lamejs expects Int16
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 128);
    const mp3Data = [];

    // We need separate left/right Int16 arrays
    // Chunk processing for memory safety?
    const sampleBlockSize = 1152;
    const left = buffer.getChannelData(0);
    const right = channels > 1 ? buffer.getChannelData(1) : left;

    const leftInt16 = new Int16Array(samples);
    const rightInt16 = new Int16Array(samples);

    for (let i = 0; i < samples; i++) {
        leftInt16[i] = Math.max(-1, Math.min(1, left[i])) * (left[i] < 0 ? 0x8000 : 0x7FFF);
        rightInt16[i] = Math.max(-1, Math.min(1, right[i])) * (right[i] < 0 ? 0x8000 : 0x7FFF);
    }

    // Encode
    // We can encode in one go if small, or chunks.
    // lamejs.encodeBuffer(left, right)

    const mp3buf = mp3encoder.encodeBuffer(leftInt16, rightInt16);
    if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
    }

    const endBuf = mp3encoder.flush();
    if (endBuf.length > 0) {
        mp3Data.push(endBuf);
    }

    const blob = new Blob(mp3Data, { type: 'audio/mp3' });
    triggerDownload(blob, 'audio_lab_export.mp3');
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// --- Helpers ---

function showLoading(show) {
    if (show) loadingOverlay.classList.remove('hidden');
    else loadingOverlay.classList.add('hidden');
}
