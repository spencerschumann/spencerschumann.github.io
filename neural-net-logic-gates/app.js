window.network = {}; // Make network globally accessible for debugging and testing
let network = window.network;

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('nn-canvas');
    if (!canvas) {
        console.error('Canvas element not found!');
        return;
    }
    const ctx = canvas.getContext('2d');

    // --- UTILITY FUNCTIONS ---
    const activationFunctions = {
        sigmoid: x => 1 / (1 + Math.exp(-x)),
        relu: x => Math.max(0, x),
        tanh: x => Math.tanh(x)
    };

    function getSelectedActivationFunction() {
        // Force ReLU only — remove selectable activation
        return activationFunctions.relu;
    }

    function getRandomWeight() {
        return 0; // Start weights/biases at 0 by default
    }

    // --- NETWORK INITIALIZATION ---
    function createNeuron(inputCount) {
        return {
            weights: Array.from({ length: inputCount }, getRandomWeight),
            bias: getRandomWeight(),
            output: 0,
            delta: 0
        };
    }

    function createLayer(neuronCount, inputCount) {
        return Array.from({ length: neuronCount }, () => createNeuron(inputCount));
    }

    // initializeNetwork now accepts outputCount so we can build multi-output nets
    function initializeNetwork(inputCount = 2, hiddenLayerCounts = [], outputCount = 1) {
        // preserve previously-saved layers if present (support single hidden layer slot + output slot)
        const saved = network.savedSlots || { hidden: null, output: null };
        network.layers = [];
        // initialize or preserve input values for on-canvas toggles
        network.inputValues = network.inputValues ? network.inputValues.slice(0, inputCount) : [];
        while (network.inputValues.length < inputCount) network.inputValues.push(0);
        let currentInputCount = inputCount;

        // Helper to create a neuron using saved values when available
        function createNeuronFromSaved(inputCount, savedNeuron) {
            const weights = Array.from({ length: inputCount }, (_, i) => {
                if (savedNeuron && Array.isArray(savedNeuron.weights) && savedNeuron.weights[i] !== undefined) return savedNeuron.weights[i];
                return 0;
            });
            const bias = savedNeuron && typeof savedNeuron.bias === 'number' ? savedNeuron.bias : 0;
            return { weights, bias, output: 0, delta: 0 };
        }

        // For the simplified single-hidden-layer model we keep saved slots to avoid accidental overwrite.
        function findSavedLayer(desiredNeuronCount, desiredInputCount, role) {
            // role can be 'hidden' or 'output' - prefer exact saved slot first
            if (saved && role && saved[role]) {
                const sLayer = saved[role];
                if (Array.isArray(sLayer) && sLayer.length === desiredNeuronCount) {
                    if (!sLayer[0] || !Array.isArray(sLayer[0].weights) || sLayer[0].weights.length !== desiredInputCount) {
                        // if weight length mismatches, still allow if neuron counts match (best-effort)
                        return sLayer;
                    }
                    return sLayer;
                }
            }
            // fallback: try to match by neuron count and input length in any saved slot
            for (const key of ['hidden', 'output']) {
                const sLayer = saved[key];
                if (!Array.isArray(sLayer)) continue;
                if (sLayer.length === desiredNeuronCount) return sLayer;
                if (sLayer[0] && Array.isArray(sLayer[0].weights) && sLayer[0].weights.length === desiredInputCount) return sLayer;
            }
            return [];
        }

        hiddenLayerCounts.forEach((neuronCount, layerIdx) => {
            const layerSaved = findSavedLayer(neuronCount, currentInputCount, 'hidden') || [];
            const layer = Array.from({ length: neuronCount }, (_, nIdx) => createNeuronFromSaved(currentInputCount, layerSaved[nIdx]));
            network.layers.push(layer);
            currentInputCount = neuronCount;
        });

        const outLayerSaved = findSavedLayer(outputCount, currentInputCount, 'output') || [];
        const outputLayer = Array.from({ length: outputCount }, (_, nIdx) => createNeuronFromSaved(currentInputCount, outLayerSaved[nIdx]));
        network.layers.push(outputLayer);
    }

    function saveNetworkWeights() {
        if (!network.layers) return;
        // Use named slots so we don't accidentally overwrite hidden slot when network temporarily lacks it.
        network.savedSlots = network.savedSlots || { hidden: null, output: null };
        if (network.layers.length === 1) {
            // Only output layer present — update output slot but keep hidden slot intact
            const outLayer = network.layers[0];
            network.savedSlots.output = outLayer.map(n => ({ weights: Array.isArray(n.weights) ? n.weights.slice() : [], bias: typeof n.bias === 'number' ? n.bias : 0 }));
        } else if (network.layers.length >= 2) {
            // Hidden + output
            const hidden = network.layers[0];
            const output = network.layers[1];
            network.savedSlots.hidden = hidden.map(n => ({ weights: Array.isArray(n.weights) ? n.weights.slice() : [], bias: typeof n.bias === 'number' ? n.bias : 0 }));
            network.savedSlots.output = output.map(n => ({ weights: Array.isArray(n.weights) ? n.weights.slice() : [], bias: typeof n.bias === 'number' ? n.bias : 0 }));
        }
    }

    // Helper to format feedForward output (supports scalar or array outputs)
    function formatOutputForDisplay(output) {
        if (Array.isArray(output)) {
            return output.map(v => `${v.toFixed(3)} (${v >= 0.5 ? 'ON' : 'OFF'})`).join(' | ');
        }
        if (typeof output === 'number') {
            return `${output.toFixed(3)} (${output >= 0.5 ? 'ON' : 'OFF'})`;
        }
        try {
            const num = Number(output);
            if (!isNaN(num)) return `${num.toFixed(3)} (${num >= 0.5 ? 'ON' : 'OFF'})`;
        } catch (e) { }
        return String(output);
    }

    // --- DRAWING FUNCTIONS ---
    function resizeCanvas() {
        const container = document.getElementById('visualization');
        const size = container.clientWidth > 0 ? container.clientWidth : 400;
        // Account for high-DPI displays to avoid pixelation
        const ratio = window.devicePixelRatio || 1;
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';
        canvas.width = Math.max(1, Math.floor(size * ratio));
        canvas.height = Math.max(1, Math.floor(size * ratio));
        // Set transform so drawing operations are in CSS pixels
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawNetwork(ctx);
    }

    function drawNeuron(ctx, x, y, radius, label, output = 0) {
        // Draw neuron with neutral fill (no shading by output)
        ctx.fillStyle = '#f5f5f5';
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.closePath();

        // Label (static color) - place above the neuron
        ctx.fillStyle = '#111';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.font = '12px Arial';
        ctx.fillText(label, x, y - radius - 6);
    }

    // --- TRUTH TABLE ---
    function getTruthTableData(gate) {
        switch (gate) {
            case 'not': return [{ inputs: [0], expected: 1 }, { inputs: [1], expected: 0 }];
            case 'or': return [{ inputs: [0, 0], expected: 0 }, { inputs: [0, 1], expected: 1 }, { inputs: [1, 0], expected: 1 }, { inputs: [1, 1], expected: 1 }];
            case 'and': return [{ inputs: [0, 0], expected: 0 }, { inputs: [0, 1], expected: 0 }, { inputs: [1, 0], expected: 0 }, { inputs: [1, 1], expected: 1 }];
            case 'xor': return [{ inputs: [0, 0], expected: 0 }, { inputs: [0, 1], expected: 1 }, { inputs: [1, 0], expected: 1 }, { inputs: [1, 1], expected: 0 }];
            case 'full-adder': {
                // inputs: [A,B,Cin] -> expected: [Sum, Carry]
                const rows = [];
                for (let a = 0; a <= 1; a++) {
                    for (let b = 0; b <= 1; b++) {
                        for (let c = 0; c <= 1; c++) {
                            const s = (a + b + c) % 2;
                            const carry = (a + b + c) >= 2 ? 1 : 0;
                            rows.push({ inputs: [a, b, c], expected: [s, carry] });
                        }
                    }
                }
                return rows;
            }
            default: return [];
        }
    }

    const challenges = ['not', 'or', 'and', 'xor'];
    let currentChallengeIndex = 0;

    function updateTruthTable() {
        const gateSelect = document.getElementById('gate-select');
        const gate = gateSelect.value;
        document.getElementById('challenge-name').textContent = gate.toUpperCase();

        const tableData = getTruthTableData(gate);
        const tableElement = document.getElementById('truth-table');
        tableElement.innerHTML = '';

        if (tableData.length === 0) return;

        // Create header showing inputs and one-or-more output columns
        const headerRow = tableElement.insertRow();
        const inputCount = tableData[0].inputs.length;
        for (let i = 0; i < inputCount; i++) {
            headerRow.insertCell().textContent = `Input ${i + 1}`;
        }
        // Determine output count from expected value shape
        const firstExpected = tableData[0].expected;
        const outputCount = Array.isArray(firstExpected) ? firstExpected.length : 1;
        for (let o = 0; o < outputCount; o++) {
            headerRow.insertCell().textContent = `NN Output ${o + 1}`;
        }

        // Create data rows
        tableData.forEach(row => {
            const tableRow = tableElement.insertRow();
            row.inputs.forEach(input => {
                tableRow.insertCell().textContent = input;
            });
            for (let o = 0; o < outputCount; o++) tableRow.insertCell().textContent = '?';
        });
    }

    function checkChallengeCompletion() {
        const gateSelect = document.getElementById('gate-select');
        const gate = gateSelect.value;
        const tableData = getTruthTableData(gate);
        let allCorrect = true;

        for (const row of tableData) {
            const outputs = feedForward(row.inputs);
            const expected = row.expected;
            if (Array.isArray(expected)) {
                for (let i = 0; i < expected.length; i++) {
                    const outBit = (outputs[i] >= 0.5) ? 1 : 0;
                    if (outBit !== expected[i]) { allCorrect = false; break; }
                }
                if (!allCorrect) break;
            } else {
                const outBit = (outputs && outputs[0] >= 0.5) ? 1 : 0;
                if (outBit !== expected) { allCorrect = false; break; }
            }
        }

            if (allCorrect) {
                document.getElementById('challenge-message').textContent = 'Success! Challenge complete!';
                const currentIndex = challenges.indexOf(gate);
                const nextBtn = document.getElementById('next-challenge-btn');
                if (currentIndex < challenges.length - 1) {
                    if (nextBtn) {
                        nextBtn.classList.add('visible');
                        nextBtn.disabled = false;
                    }
                } else {
                    document.getElementById('challenge-message').textContent = 'Congratulations! You have completed all challenges!';
                    if (nextBtn) nextBtn.classList.remove('visible');
                }
            }
    }

    function drawConnection(ctx, x1, y1, x2, y2, weight) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = Math.max(0.5, Math.min(Math.abs(weight), 4));
        const nearZero = Math.abs(weight) < 0.05;
        if (nearZero) {
            ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        } else if (weight > 0) {
            ctx.strokeStyle = 'rgba(0, 123, 255, 0.9)';
        } else {
            ctx.strokeStyle = 'rgba(220, 53, 69, 0.9)';
        }
        ctx.stroke();
        ctx.closePath();
    }

    // Distance from point to segment for hit testing
    function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const len_sq = C * C + D * D;
        let param = -1;
        if (len_sq !== 0) param = dot / len_sq;

        let xx, yy;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        const dx = px - xx;
        const dy = py - yy;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // --- NEURAL NETWORK LOGIC ---
    function activate(weights, inputs, bias) {
        let sum = bias;
        for (let i = 0; i < weights.length; i++) {
            const inVal = (inputs && typeof inputs[i] === 'number') ? inputs[i] : 0;
            sum += weights[i] * inVal;
        }
        const activation = getSelectedActivationFunction();
        return activation(sum);
    }

    function feedForward(inputs) {
        let currentInputs = inputs;
        for (const layer of network.layers) {
            const newOutputs = [];
            for (const neuron of layer) {
                const output = activate(neuron.weights, currentInputs, neuron.bias);
                neuron.output = output;
                newOutputs.push(output);
            }
            currentInputs = newOutputs;
        }
        // Return full output array (support multi-output networks)
        return currentInputs;
    }

    function runNetwork() {
        const gate = document.getElementById('gate-select').value;
        const tableData = getTruthTableData(gate);
        const tableElement = document.getElementById('truth-table');
        if (!tableElement.rows || tableElement.rows.length === 0) {
            return;
        }
        const outputColumnIndex = tableElement.rows[0].cells.length - 1;

        // Determine output count from row structure
        const firstExpected = tableData[0].expected;
        const outputCount = Array.isArray(firstExpected) ? firstExpected.length : 1;

        tableData.forEach((row, rowIndex) => {
            const outputs = feedForward(row.inputs); // returns array
            for (let o = 0; o < outputCount; o++) {
                const cellIndex = outputColumnIndex - (outputCount - 1) + o;
                const outputCell = tableElement.rows[rowIndex + 1].cells[cellIndex];
                const val = outputs && outputs[o] !== undefined ? outputs[o] : 0;
                outputCell.textContent = val.toFixed(3);

                const expected = Array.isArray(row.expected) ? row.expected[o] : row.expected;
                const isCorrect = (((val >= 0.5) ? 1 : 0) === expected);
                outputCell.style.backgroundColor = isCorrect ? '#d4edda' : '#f8d7da';
            }
        });

        drawNetwork(ctx);
        checkChallengeCompletion();
    }

    function drawNetwork(ctx) {
        // Use CSS pixel dimensions for layout when canvas is scaled for DPR
        const ratio = window.devicePixelRatio || 1;
        const width = ctx.canvas.width / ratio;
        const height = ctx.canvas.height / ratio;
        // Clear using CSS-pixel dimensions so clearing matches drawing coordinates
        ctx.clearRect(0, 0, width, height);

        if (!network.layers || network.layers.length === 0 || !network.layers[0][0]) {
            return;
        }

            const neuronRadius = 30;
        const onColor = 'rgba(0,123,255,0.95)';
        const offColor = 'rgba(200,200,200,0.9)';
        const layerPadding = 100;

        const inputCount = network.layers[0][0].weights.length;
        const allLayers = [{ neurons: Array(inputCount) }, ...network.layers];
        const totalLayers = allLayers.length;
        const layerSpacing = (totalLayers > 1) ? (width - 2 * layerPadding) / (totalLayers - 1) : 0;

        network.neuronPositions = [];

        allLayers.forEach((layer, layerIndex) => {
            const layerPositions = [];
            const layerX = layerPadding + layerIndex * layerSpacing;
            const neuronCount = layer.neurons ? layer.neurons.length : layer.length;

            for (let i = 0; i < neuronCount; i++) {
                const y = (height / (neuronCount + 1)) * (i + 1);
                layerPositions.push({ x: layerX, y: y });
            }
            network.neuronPositions.push(layerPositions);
        });

            // Center hidden layers roughly between input and output (avoid hugging output)
            if (network.neuronPositions && network.neuronPositions.length >= 3) {
                const leftX = network.neuronPositions[0][0].x;
                const rightX = network.neuronPositions[network.neuronPositions.length - 1][0].x;
                const midX = (leftX + rightX) / 2;
                for (let li = 1; li < network.neuronPositions.length - 1; li++) {
                    network.neuronPositions[li].forEach(p => { p.x = midX; });
                }
            }
        // Draw connections and record positions for hit testing
        network.connectionPositions = [];
        network.layers.forEach((layer, layerIndex) => {
            const prevLayerPositions = network.neuronPositions[layerIndex];
            const currentLayerPositions = network.neuronPositions[layerIndex + 1];
            layer.forEach((neuron, neuronIndex) => {
                neuron.weights.forEach((weight, weightIndex) => {
                    const prevNeuronPos = prevLayerPositions[weightIndex];
                    const currentNeuronPos = currentLayerPositions[neuronIndex];
                    drawConnection(ctx, prevNeuronPos.x, prevNeuronPos.y, currentNeuronPos.x, currentNeuronPos.y, weight);
                    network.connectionPositions.push({
                        layerIndex: layerIndex,
                        toNeuronIndex: neuronIndex,
                        fromNeuronIndex: weightIndex,
                        x1: prevNeuronPos.x,
                        y1: prevNeuronPos.y,
                        x2: currentNeuronPos.x,
                        y2: currentNeuronPos.y,
                        weightRef: () => network.layers[layerIndex][neuronIndex].weights[weightIndex]
                    });
                });
            });
        });

        // Draw neurons and bias icons (with hit data)
        network.biasPositions = [];
        network.neuronPositions.forEach((layer, layerIndex) => {
            layer.forEach((pos, neuronIndex) => {
                        if (layerIndex === 0) {
                            // input neuron: draw only the toggle directly at the input position (no neuron circle)
                            const inputVal = (network.inputValues && network.inputValues[neuronIndex] === 1) ? 1 : 0;
                            const toggleRadius = 10;
                            const tx = pos.x; // place toggle where the input neuron would be
                            const ty = pos.y;
                            ctx.beginPath();
                            ctx.arc(tx, ty, toggleRadius, 0, Math.PI * 2);
                            ctx.fillStyle = inputVal ? onColor : offColor;
                            ctx.fill();
                            ctx.strokeStyle = '#222';
                            ctx.lineWidth = 1;
                            ctx.stroke();
                            ctx.closePath();

                            // small value inside
                            ctx.fillStyle = inputVal ? 'white' : '#333';
                            ctx.font = '11px Arial';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(inputVal ? '1' : '0', tx, ty);

                            // record toggle position for hit testing
                            if (!network.inputTogglePositions) network.inputTogglePositions = [];
                            network.inputTogglePositions[neuronIndex] = { index: neuronIndex, x: tx, y: ty, size: toggleRadius };
                        } else {
                    const neuron = network.layers[layerIndex - 1][neuronIndex];
                    const label = `N${layerIndex - 1}-${neuronIndex}`;
                    drawNeuron(ctx, pos.x, pos.y, neuronRadius, label, neuron.output);

                    // Draw activation function graph inside the neuron
                    try {
                        const layerIdx = layerIndex - 1; // index in network.layers
                        // gather inputs for this neuron (previous layer outputs or network.inputValues)
                        let inputsForNeuron = [];
                        if (layerIdx === 0) {
                            inputsForNeuron = (network.inputValues || []).slice();
                        } else {
                            inputsForNeuron = network.layers[layerIdx - 1].map(n => n.output);
                        }

                        // compute pre-activation sum for current inputs
                        let sumVal = neuron.bias || 0;
                        for (let wi = 0; wi < neuron.weights.length; wi++) {
                            const inVal = (inputsForNeuron[wi] !== undefined) ? inputsForNeuron[wi] : 0;
                            sumVal += neuron.weights[wi] * inVal;
                        }

                        const actFn = getSelectedActivationFunction();
                        const graphRadius = neuronRadius - 8;
                        const actKey = 'relu';
                        const clamp = 1.5;

                        // axes
                        ctx.beginPath();
                        ctx.strokeStyle = '#222';
                        ctx.lineWidth = 1;
                        // x axis
                        ctx.moveTo(pos.x - graphRadius, pos.y);
                        ctx.lineTo(pos.x + graphRadius, pos.y);
                        // y axis
                        ctx.moveTo(pos.x, pos.y - graphRadius);
                        ctx.lineTo(pos.x, pos.y + graphRadius);
                        ctx.stroke();
                        ctx.closePath();

                        // draw activation curve (blue line, dark axes)
                        ctx.beginPath();
                        let samples = 60;
                        for (let i = 0; i <= samples; i++) {
                            const sx = -clamp + (i / samples) * (2 * clamp);
                            let sy = actFn(sx);
                            // clamp display y
                            if (sy > clamp) sy = clamp;
                            if (sy < -clamp) sy = -clamp;
                            const px = pos.x + (sx / clamp) * graphRadius;
                            const py = pos.y - (sy / clamp) * graphRadius;
                            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                        }
                        ctx.strokeStyle = onColor; // blue for contrast
                        ctx.lineWidth = 2.0;
                        ctx.stroke();
                        ctx.closePath();

                        // draw dot for current sum/output
                        let dispX = sumVal;
                        let dispY = actFn(sumVal);
                        if (dispX > clamp) dispX = clamp;
                        if (dispX < -clamp) dispX = -clamp;
                        if (dispY > clamp) dispY = clamp;
                        if (dispY < -clamp) dispY = -clamp;
                        const dotX = pos.x + (dispX / clamp) * graphRadius;
                        const dotY = pos.y - (dispY / clamp) * graphRadius;
                        ctx.beginPath();
                        ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
                        ctx.fillStyle = '#ffeb3b';
                        ctx.fill();
                        ctx.strokeStyle = '#222';
                        ctx.lineWidth = 1;
                        ctx.stroke();
                        ctx.closePath();
                    } catch (e) {
                        // ignore activation drawing errors
                    }

                    // Draw bias icon (small square beneath neuron)
                    const iconSize = 10;
                    const iconX = pos.x - iconSize / 2;
                    const iconY = pos.y + neuronRadius + 6;
                    ctx.beginPath();
                    ctx.rect(iconX, iconY, iconSize, iconSize);
                        // Color bias similar to connections: black when near zero, blue for positive, red for negative
                        const b = neuron.bias || 0;
                        if (Math.abs(b) < 0.05) ctx.fillStyle = 'rgba(0,0,0,0.9)';
                        else ctx.fillStyle = b >= 0 ? onColor : 'rgba(220,53,69,0.95)';
                    ctx.fill();
                    ctx.strokeStyle = '#222';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.closePath();

                    network.biasPositions.push({
                        layerIndex: layerIndex - 1,
                        neuronIndex: neuronIndex,
                        x: iconX + iconSize / 2,
                        y: iconY + iconSize / 2,
                        size: iconSize
                    });
                }
            });
        });

        // Draw a small output indicator to the right showing numeric value and ON/OFF
        try {
            const outLayerIdx = network.layers.length - 1;
            if (outLayerIdx >= 0) {
                const outNeuron = network.layers[outLayerIdx][0];
                const outPosLayer = network.neuronPositions[network.neuronPositions.length - 1];
                if (outPosLayer && outPosLayer[0]) {
                    const outPos = outPosLayer[0];
                    const outX = Math.max(width - 50, outPos.x + 50);
                    const outY = outPos.y;
                    const outRadius = 16;
                    // Prefer computing output from current custom input toggles when available,
                    // otherwise fall back to the neuron's stored output (from challenge runs).
                    let val = 0;
                    try {
                        const inputCount = (network.layers && network.layers[0] && network.layers[0][0]) ? network.layers[0][0].weights.length : null;
                        if (inputCount !== null && network.inputValues && network.inputValues.length >= inputCount) {
                            val = feedForward(network.inputValues.slice(0, inputCount));
                        } else {
                            val = outNeuron && typeof outNeuron.output === 'number' ? outNeuron.output : 0;
                        }
                    } catch (e) {
                        val = outNeuron && typeof outNeuron.output === 'number' ? outNeuron.output : 0;
                    }
                    ctx.beginPath();
                    ctx.arc(outX, outY, outRadius, 0, Math.PI * 2);
                    ctx.fillStyle = val >= 0.5 ? onColor : offColor;
                    ctx.fill();
                    ctx.strokeStyle = '#222';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.closePath();

                    // numeric text
                    ctx.fillStyle = 'white';
                    ctx.font = '12px Arial';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(val.toFixed(2), outX, outY);

                    // ON/OFF label beneath
                    ctx.font = '11px Arial';
                    ctx.fillStyle = '#111';
                    ctx.fillText(val >= 0.5 ? 'ON' : 'OFF', outX, outY + outRadius + 12);

                    // small connector line from neuron to indicator
                    ctx.beginPath();
                    ctx.moveTo(outPos.x + 20, outPos.y);
                    ctx.lineTo(outX - outRadius, outY);
                    ctx.strokeStyle = '#888';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.closePath();
                }
            }
        } catch (e) {
            // ignore drawing errors
        }
    }

    let selectedNeuron = null; // To track which neuron is being edited
    let dragState = null; // {type, layerIndex, neuronIndex, weightIndex, startY, startValue}

    // --- MODAL LOGIC ---
    function openEditModal(layerIndex, neuronIndex) {
        selectedNeuron = { layerIndex, neuronIndex };
        const neuron = network.layers[layerIndex][neuronIndex];
        const modal = document.getElementById('edit-neuron-modal');
        const modalBody = document.getElementById('modal-body');
        document.getElementById('modal-title').textContent = `Edit Neuron N${layerIndex}-${neuronIndex}`;
        modalBody.innerHTML = '';

        // Bias input
        let group = document.createElement('div');
        group.className = 'control-group';
        let label = document.createElement('label');
        label.textContent = 'Bias:';
        let input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.value = neuron.bias.toFixed(2);
        input.id = 'neuron-bias-input';
        group.appendChild(label);
        group.appendChild(input);
        modalBody.appendChild(group);

        // Weight inputs
        neuron.weights.forEach((weight, i) => {
            group = document.createElement('div');
            group.className = 'control-group';
            label = document.createElement('label');
            label.textContent = `Weight ${i + 1}:`;
            input = document.createElement('input');
            input.type = 'number';
            input.step = '0.1';
            input.value = weight.toFixed(2);
            input.id = `neuron-weight-input-${i}`;
            group.appendChild(label);
            group.appendChild(input);
            modalBody.appendChild(group);
        });

        modal.style.display = 'flex';
    }

    function closeEditModal() {
        document.getElementById('edit-neuron-modal').style.display = 'none';
        selectedNeuron = null;
    }

    function saveNeuronChanges() {
        if (!selectedNeuron) return;
        const { layerIndex, neuronIndex } = selectedNeuron;
        const neuron = network.layers[layerIndex][neuronIndex];

        // Save bias
        const biasInput = document.getElementById('neuron-bias-input');
        neuron.bias = parseFloat(biasInput.value);

        // Save weights
        neuron.weights.forEach((_, i) => {
            const weightInput = document.getElementById(`neuron-weight-input-${i}`);
            neuron.weights[i] = parseFloat(weightInput.value);
        });

        closeEditModal();
        runNetwork(); // Re-run the network with the new values
    }

    // --- EVENT LISTENERS ---
    function setupEventListeners() {
        // Allow the user to select the challenge
        const gateSelect = document.getElementById('gate-select');
        gateSelect.disabled = false;
        // When the user selects a different challenge, rebuild the network
        gateSelect.addEventListener('change', () => {
            document.getElementById('challenge-message').textContent = 'Configure the network to solve the challenge!';
            // When switching challenges, clear saved weights so the network starts from zeros
            network._skipSaveOnNextRebuild = true;
            // Hide next button when switching
            const nextBtn = document.getElementById('next-challenge-btn');
            if (nextBtn) nextBtn.classList.remove('visible');
            rebuildAndRerunNetwork();
        });
        // Hidden layer toggle (0 or 1 hidden layers)
        const hasHiddenEl = document.getElementById('has-hidden');
        const hiddenNeuronsEl = document.getElementById('hidden-neurons');
        if (hasHiddenEl && hiddenNeuronsEl) {
            hasHiddenEl.addEventListener('change', () => {
                updateHiddenLayerControls();
                rebuildAndRerunNetwork();
            });
            hiddenNeuronsEl.addEventListener('input', rebuildAndRerunNetwork);
        }

        // Activation is fixed to ReLU; no DOM control to listen for.

        const resetWeightsBtn = document.getElementById('reset-weights');
        resetWeightsBtn.addEventListener('click', () => {
            // Mark next rebuild to skip saving (clears saved layers)
            network._skipSaveOnNextRebuild = true;
            rebuildAndRerunNetwork(); // This will re-initialize with the current settings
        });

        // Modal event listeners
        document.querySelector('.close-btn').addEventListener('click', closeEditModal);
        document.getElementById('save-neuron-btn').addEventListener('click', saveNeuronChanges);
        window.addEventListener('click', (event) => {
            if (event.target == document.getElementById('edit-neuron-modal')) {
                closeEditModal();
            }
        });

        // Next challenge button
        const nextBtn = document.getElementById('next-challenge-btn');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                const gateSelect = document.getElementById('gate-select');
                const currentIndex = challenges.indexOf(gateSelect.value);
                if (currentIndex < challenges.length - 1) {
                    const nextChallenge = challenges[currentIndex + 1];
                    gateSelect.value = nextChallenge;
                    document.getElementById('challenge-message').textContent = 'Configure the network to solve the challenge!';
                    nextBtn.classList.remove('visible');
                    rebuildAndRerunNetwork();
                }
            });
        }

        // Interactive drag handlers for weights and biases
        const tooltip = document.getElementById('drag-tooltip');

        canvas.addEventListener('mousedown', (event) => {
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            if (!network.neuronPositions) return;

            // Check input toggles first to avoid accidental weight drags over toggles
            if (network.inputTogglePositions) {
                let hitInput = null;
                for (const t of network.inputTogglePositions) {
                    if (!t) continue;
                    const dx = x - t.x;
                    const dy = y - t.y;
                    if (Math.sqrt(dx * dx + dy * dy) < t.size + 4) { hitInput = t; break; }
                }
                if (hitInput) {
                    const idx = hitInput.index;
                    network.inputValues[idx] = network.inputValues[idx] === 1 ? 0 : 1;
                    // sync sidebar checkbox if present
                    const el = document.getElementById(`custom-input-${idx}`);
                    const valSpan = document.getElementById(`custom-input-${idx}-value`);
                    if (el) el.checked = network.inputValues[idx] === 1;
                    if (valSpan) valSpan.textContent = String(network.inputValues[idx]);
                    // update output
                    const inputsArr = network.inputValues.slice(0, network.inputValues.length);
                    const output = feedForward(inputsArr);
                    const outEl = document.getElementById('custom-output');
                    if (outEl) outEl.textContent = formatOutputForDisplay(output);
                    drawNetwork(ctx);
                    event.preventDefault();
                    return;
                }
            }

            // Check connections next
            let hitConn = null;
            if (network.connectionPositions) {
                for (const conn of network.connectionPositions) {
                    const d = pointToSegmentDistance(x, y, conn.x1, conn.y1, conn.x2, conn.y2);
                    if (d < 8) { hitConn = conn; break; }
                }
            }

            if (hitConn) {
                dragState = {
                    type: 'weight',
                    layerIndex: hitConn.layerIndex,
                    neuronIndex: hitConn.toNeuronIndex,
                    weightIndex: hitConn.fromNeuronIndex,
                    startY: y,
                    startValue: network.layers[hitConn.layerIndex][hitConn.toNeuronIndex].weights[hitConn.fromNeuronIndex]
                };
                canvas.style.cursor = 'ns-resize';
                if (tooltip) { tooltip.style.display = 'block'; tooltip.textContent = `Weight: ${dragState.startValue.toFixed(2)}`; tooltip.style.left = (event.clientX + 12) + 'px'; tooltip.style.top = (event.clientY + 12) + 'px'; }
                event.preventDefault();
                return;
            }

            // Check bias icons
            let hitBias = null;
            if (network.biasPositions) {
                for (const b of network.biasPositions) {
                    const dx = x - b.x;
                    const dy = y - b.y;
                    if (Math.sqrt(dx * dx + dy * dy) < b.size) { hitBias = b; break; }
                }
            }

            if (hitBias) {
                dragState = {
                    type: 'bias',
                    layerIndex: hitBias.layerIndex,
                    neuronIndex: hitBias.neuronIndex,
                    startY: y,
                    startValue: network.layers[hitBias.layerIndex][hitBias.neuronIndex].bias
                };
                canvas.style.cursor = 'ns-resize';
                if (tooltip) { tooltip.style.display = 'block'; tooltip.textContent = `Bias: ${dragState.startValue.toFixed(2)}`; tooltip.style.left = (event.clientX + 12) + 'px'; tooltip.style.top = (event.clientY + 12) + 'px'; }
                event.preventDefault();
                return;
            }
        });

        canvas.addEventListener('mousemove', (event) => {
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            // Hover detection when not actively dragging
            if (!dragState) {
                let hovering = false;
                if (network.connectionPositions) {
                    for (const conn of network.connectionPositions) {
                        const d = pointToSegmentDistance(x, y, conn.x1, conn.y1, conn.x2, conn.y2);
                        if (d < 8) { hovering = true; break; }
                    }
                }
                if (!hovering && network.biasPositions) {
                    for (const b of network.biasPositions) {
                        const dx = x - b.x;
                        const dy = y - b.y;
                        if (Math.sqrt(dx * dx + dy * dy) < b.size) { hovering = true; break; }
                    }
                }
                if (!hovering && network.inputTogglePositions) {
                    for (const t of network.inputTogglePositions) {
                        if (!t) continue;
                        const dx = x - t.x;
                        const dy = y - t.y;
                        if (Math.sqrt(dx * dx + dy * dy) < t.size + 4) { hovering = true; break; }
                    }
                }
                canvas.style.cursor = hovering ? 'pointer' : 'default';
                return;
            }

            const deltaY = dragState.startY - y;
            const sensitivity = 0.02; // change-per-pixel

            if (dragState.type === 'weight') {
                const newVal = dragState.startValue + deltaY * sensitivity;
                network.layers[dragState.layerIndex][dragState.neuronIndex].weights[dragState.weightIndex] = newVal;
                if (tooltip) { tooltip.textContent = `Weight: ${newVal.toFixed(2)}`; tooltip.style.left = (event.clientX + 12) + 'px'; tooltip.style.top = (event.clientY + 12) + 'px'; }
            } else if (dragState.type === 'bias') {
                const newVal = dragState.startValue + deltaY * sensitivity;
                network.layers[dragState.layerIndex][dragState.neuronIndex].bias = newVal;
                if (tooltip) { tooltip.textContent = `Bias: ${newVal.toFixed(2)}`; tooltip.style.left = (event.clientX + 12) + 'px'; tooltip.style.top = (event.clientY + 12) + 'px'; }
            }

            // Update both the challenge truth-table outputs and the custom input display.
            runNetwork();
            try {
                // determine expected input count from first layer weights
                const inputCount = (network.layers && network.layers[0] && network.layers[0][0]) ? network.layers[0][0].weights.length : null;
                if (inputCount !== null && network.inputValues && network.inputValues.length >= inputCount) {
                    const inputs = network.inputValues.slice(0, inputCount);
                    const output = feedForward(inputs);
                    const outEl = document.getElementById('custom-output');
                    if (outEl) outEl.textContent = formatOutputForDisplay(output);
                }
            } catch (e) {
                // ignore custom output update errors
            }
        });

        const endDrag = () => {
            if (!dragState) return;
            dragState = null;
            canvas.style.cursor = 'default';
            if (tooltip) tooltip.style.display = 'none';
            runNetwork();
        };

        canvas.addEventListener('mouseup', endDrag);
        canvas.addEventListener('mouseleave', endDrag);

        // Custom inputs
        // Test-your-network UI removed; no test button listener needed.
    }

    // Custom test UI removed; on-canvas toggles are used instead.

    // Simplified hidden-layer controls: single checkbox (hasHidden) and one neuron count
    function updateHiddenLayerControls() {
        const hasHidden = document.getElementById('has-hidden');
        const hiddenNeurons = document.getElementById('hidden-neurons');
        if (!hasHidden || !hiddenNeurons) return;
        hiddenNeurons.style.display = hasHidden.checked ? 'inline-block' : 'none';
    }

    function getHiddenLayerNeuronCounts() {
        const hasHidden = document.getElementById('has-hidden');
        const hiddenNeurons = document.getElementById('hidden-neurons');
        if (!hasHidden || !hasHidden.checked) return [];
        const n = hiddenNeurons ? parseInt(hiddenNeurons.value, 10) : 2;
        return [isNaN(n) ? 2 : n];
    }

    function rebuildAndRerunNetwork() {
        // Save current weights so we can restore them when counts change
        if (network._skipSaveOnNextRebuild) {
            // reset was requested; clear saved slots (new) and legacy savedLayers, then consume the flag
            network.savedSlots = { hidden: null, output: null };
            network.savedLayers = [];
            delete network._skipSaveOnNextRebuild;
        } else {
            saveNetworkWeights();
        }
        // Hide next-challenge button whenever rebuilding to avoid accidental advance
        const nextBtn = document.getElementById('next-challenge-btn');
        if (nextBtn) nextBtn.classList.remove('visible');
        const gate = document.getElementById('gate-select').value;
        const tableData = getTruthTableData(gate);
        const inputCount = tableData.length > 0 ? tableData[0].inputs.length : 1;
        const hiddenLayerCounts = getHiddenLayerNeuronCounts();
        const firstExpected = tableData.length > 0 ? tableData[0].expected : 0;
        const outputCount = Array.isArray(firstExpected) ? firstExpected.length : 1;

        initializeNetwork(inputCount, hiddenLayerCounts, outputCount);
        updateTruthTable(); // This is needed to reset the output column
        runNetwork();
    }

    // --- INITIALIZATION ---
    function init() {
        try {
            // Explicitly set the initial state to ensure consistency.
            // The default gate is 'not', which requires 1 input.
            const initialGate = 'not';
            document.getElementById('gate-select').value = initialGate;
            // Default activation to ReLU for this demo
            // Activation is fixed to ReLU; no DOM control present.

            const initialTableData = getTruthTableData(initialGate);
            const initialInputCount = initialTableData[0].inputs.length;

            initializeNetwork(initialInputCount);
            setupEventListeners();
            updateTruthTable();
            // Ensure hidden-layer controls initialized and then run network
            updateHiddenLayerControls();
            runNetwork();

            window.addEventListener('resize', resizeCanvas);
            resizeCanvas();
        } catch (error) {
            console.error("Error during initialization:", error);
        }
    }

    init();
});
