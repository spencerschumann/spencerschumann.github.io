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
        const activationKey = document.getElementById('activation-select').value;
        return activationFunctions[activationKey];
    }

    function getRandomWeight() {
        return (Math.random() * 4) - 2; // Random weight between -2 and 2
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

    function initializeNetwork(inputCount = 2, hiddenLayerCounts = [], outputCount = 1) {
        network.layers = [];
        let currentInputCount = inputCount;

        hiddenLayerCounts.forEach(neuronCount => {
            const layer = createLayer(neuronCount, currentInputCount);
            network.layers.push(layer);
            currentInputCount = neuronCount;
        });

        const outputLayer = createLayer(outputCount, currentInputCount);
        network.layers.push(outputLayer);
    }

    // --- DRAWING FUNCTIONS ---
    function resizeCanvas() {
        const container = document.getElementById('visualization');
        const size = container.clientWidth > 0 ? container.clientWidth : 400;
        canvas.width = size;
        canvas.height = size;
        drawNetwork(ctx);
    }

    function drawNeuron(ctx, x, y, radius, label, output = 0) {
        const fillAlpha = Math.max(0.1, output);
        ctx.fillStyle = `rgba(0, 0, 0, ${fillAlpha})`;

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
        ctx.fill();

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.closePath();

        ctx.fillStyle = output > 0.5 ? 'white' : 'black';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '12px Arial';
        ctx.fillText(label, x, y);

        ctx.font = '10px Arial';
        ctx.fillText(output.toFixed(2), x, y + radius + 10);
    }

    // --- TRUTH TABLE ---
    function getTruthTableData(gate) {
        switch (gate) {
            case 'not': return [{ inputs: [0], expected: 1 }, { inputs: [1], expected: 0 }];
            case 'or': return [{ inputs: [0, 0], expected: 0 }, { inputs: [0, 1], expected: 1 }, { inputs: [1, 0], expected: 1 }, { inputs: [1, 1], expected: 1 }];
            case 'and': return [{ inputs: [0, 0], expected: 0 }, { inputs: [0, 1], expected: 0 }, { inputs: [1, 0], expected: 0 }, { inputs: [1, 1], expected: 1 }];
            case 'xor': return [{ inputs: [0, 0], expected: 0 }, { inputs: [0, 1], expected: 1 }, { inputs: [1, 0], expected: 1 }, { inputs: [1, 1], expected: 0 }];
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

        // Create header without 'Expected' column
        const headerRow = tableElement.insertRow();
        const inputCount = tableData[0].inputs.length;
        for (let i = 0; i < inputCount; i++) {
            headerRow.insertCell().textContent = `Input ${i + 1}`;
        }
        headerRow.insertCell().textContent = 'NN Output';

        // Create data rows
        tableData.forEach(row => {
            const tableRow = tableElement.insertRow();
            row.inputs.forEach(input => {
                tableRow.insertCell().textContent = input;
            });
            tableRow.insertCell().textContent = '?';
        });
    }

    function checkChallengeCompletion() {
        const gateSelect = document.getElementById('gate-select');
        const gate = gateSelect.value;
        const tableData = getTruthTableData(gate);
        let allCorrect = true;

        for (const row of tableData) {
            const output = feedForward(row.inputs);
            if (Math.round(output) !== row.expected) {
                allCorrect = false;
                break;
            }
        }

        if (allCorrect) {
            document.getElementById('challenge-message').textContent = 'Success! Challenge complete!';
            const currentIndex = challenges.indexOf(gate);
            // Unlock next challenge after a delay
            setTimeout(() => {
                if (currentIndex < challenges.length - 1) {
                    const nextChallenge = challenges[currentIndex + 1];
                    gateSelect.value = nextChallenge;
                    document.getElementById('challenge-message').textContent = 'Configure the network to solve the challenge!';
                    rebuildAndRerunNetwork();
                } else {
                    document.getElementById('challenge-message').textContent = 'Congratulations! You have completed all challenges!';
                }
            }, 2000);
        }
    }

    function drawConnection(ctx, x1, y1, x2, y2, weight) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = Math.max(0.5, Math.min(Math.abs(weight), 4));
        ctx.strokeStyle = weight > 0 ? 'rgba(0, 123, 255, 0.8)' : 'rgba(220, 53, 69, 0.8)';
        ctx.stroke();
        ctx.closePath();
    }

    // --- NEURAL NETWORK LOGIC ---
    function activate(weights, inputs, bias) {
        let sum = bias;
        for (let i = 0; i < weights.length; i++) {
            sum += weights[i] * inputs[i];
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
        return currentInputs[0];
    }

    function runNetwork() {
        const gate = document.getElementById('gate-select').value;
        const tableData = getTruthTableData(gate);
        const tableElement = document.getElementById('truth-table');
        if (!tableElement.rows || tableElement.rows.length === 0) {
            return;
        }
        const outputColumnIndex = tableElement.rows[0].cells.length - 1;

        tableData.forEach((row, rowIndex) => {
            const output = feedForward(row.inputs);
            const outputCell = tableElement.rows[rowIndex + 1].cells[outputColumnIndex];
            outputCell.textContent = output.toFixed(3);

            const expected = row.expected;
            const isCorrect = Math.round(output) === expected;
            outputCell.style.backgroundColor = isCorrect ? '#d4edda' : '#f8d7da';
        });

        drawNetwork(ctx);
        checkChallengeCompletion();
    }

    function drawNetwork(ctx) {
        const { width, height } = ctx.canvas;
        ctx.clearRect(0, 0, width, height);

        if (!network.layers || network.layers.length === 0 || !network.layers[0][0]) {
            return;
        }

        const neuronRadius = 20;
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

        // Draw connections
        network.layers.forEach((layer, layerIndex) => {
            const prevLayerPositions = network.neuronPositions[layerIndex];
            const currentLayerPositions = network.neuronPositions[layerIndex + 1];
            layer.forEach((neuron, neuronIndex) => {
                neuron.weights.forEach((weight, weightIndex) => {
                    const prevNeuronPos = prevLayerPositions[weightIndex];
                    const currentNeuronPos = currentLayerPositions[neuronIndex];
                    drawConnection(ctx, prevNeuronPos.x, prevNeuronPos.y, currentNeuronPos.x, currentNeuronPos.y, weight);
                });
            });
        });

        // Draw neurons
        network.neuronPositions.forEach((layer, layerIndex) => {
            layer.forEach((pos, neuronIndex) => {
                if (layerIndex === 0) {
                    drawNeuron(ctx, pos.x, pos.y, neuronRadius, `I${neuronIndex + 1}`, 0);
                } else {
                    const neuron = network.layers[layerIndex - 1][neuronIndex];
                    const label = `N${layerIndex - 1}-${neuronIndex}`;
                    drawNeuron(ctx, pos.x, pos.y, neuronRadius, label, neuron.output);
                }
            });
        });
    }

    let selectedNeuron = null; // To track which neuron is being edited

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
        // Disable the gate selector as it's now controlled by challenges
        const gateSelect = document.getElementById('gate-select');
        gateSelect.disabled = true;
        const hiddenLayersInput = document.getElementById('hidden-layers');
        hiddenLayersInput.addEventListener('input', () => {
            updateHiddenLayerNeuronControls();
            rebuildAndRerunNetwork();
        });

        const activationSelect = document.getElementById('activation-select');
        activationSelect.addEventListener('change', runNetwork);

        const resetWeightsBtn = document.getElementById('reset-weights');
        resetWeightsBtn.addEventListener('click', () => {
            rebuildAndRerunNetwork(); // This will re-initialize with the current settings
        });

        const debugBtn = document.getElementById('debug-btn');
        debugBtn.addEventListener('click', () => {
            const debugOutput = document.getElementById('debug-output');
            debugOutput.textContent = JSON.stringify(network, null, 2);
            debugOutput.style.display = 'block';
        });

        // Modal event listeners
        document.querySelector('.close-btn').addEventListener('click', closeEditModal);
        document.getElementById('save-neuron-btn').addEventListener('click', saveNeuronChanges);
        window.addEventListener('click', (event) => {
            if (event.target == document.getElementById('edit-neuron-modal')) {
                closeEditModal();
            }
        });

        // Canvas click listener
        canvas.addEventListener('click', (event) => {
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;

            if (!network.neuronPositions) return;

            // Simple click detection
            network.neuronPositions.forEach((layer, layerIndex) => {
                if(layerIndex > 0) { // Can't edit input neurons
                    layer.forEach((pos, neuronIndex) => {
                        const distance = Math.sqrt((x - pos.x)**2 + (y - pos.y)**2);
                        if (distance < 20) { // 20 is the neuron radius
                            openEditModal(layerIndex - 1, neuronIndex);
                        }
                    });
                }
            });
        });

        // Custom inputs
        const testCustomInputsBtn = document.getElementById('test-custom-inputs-btn');
        testCustomInputsBtn.addEventListener('click', () => {
            const gate = document.getElementById('gate-select').value;
            const tableData = getTruthTableData(gate);
            const inputCount = tableData.length > 0 ? tableData[0].inputs.length : 1;
            const inputs = [];
            for (let i = 0; i < inputCount; i++) {
                const inputElement = document.getElementById(`custom-input-${i}`);
                inputs.push(parseFloat(inputElement.value));
            }
            const output = feedForward(inputs);
            document.getElementById('custom-output').textContent = output.toFixed(3);
            drawNetwork(ctx);
        });
    }

    function updateCustomInputControls() {
        const gate = document.getElementById('gate-select').value;
        const tableData = getTruthTableData(gate);
        const inputCount = tableData.length > 0 ? tableData[0].inputs.length : 1;
        const container = document.getElementById('custom-inputs-container');
        container.innerHTML = '';

        for (let i = 0; i < inputCount; i++) {
            const label = document.createElement('label');
            label.textContent = `Input ${i + 1}:`;
            const input = document.createElement('input');
            input.type = 'number';
            input.id = `custom-input-${i}`;
            input.min = '0';
            input.max = '1';
            input.step = '1';
            input.value = '0';
            container.appendChild(label);
            container.appendChild(input);
        }
    }

    function updateHiddenLayerNeuronControls() {
        const numHiddenLayers = parseInt(document.getElementById('hidden-layers').value, 10);
        const container = document.getElementById('hidden-layer-neurons');
        container.innerHTML = ''; // Clear existing controls

        for (let i = 0; i < numHiddenLayers; i++) {
            const label = document.createElement('label');
            label.textContent = `Neurons in Layer ${i + 1}:`;
            label.htmlFor = `neurons-layer-${i}`;

            const input = document.createElement('input');
            input.type = 'number';
            input.id = `neurons-layer-${i}`;
            input.min = '1';
            input.max = '10'; // A reasonable limit
            input.value = '2'; // Default value
            input.addEventListener('input', rebuildAndRerunNetwork);

            container.appendChild(label);
            container.appendChild(input);
        }
    }

    function getHiddenLayerNeuronCounts() {
        const numHiddenLayers = parseInt(document.getElementById('hidden-layers').value, 10);
        const counts = [];
        for (let i = 0; i < numHiddenLayers; i++) {
            const input = document.getElementById(`neurons-layer-${i}`);
            if(input) {
                counts.push(parseInt(input.value, 10));
            } else {
                counts.push(2); // Default if input not found yet
            }
        }
        return counts;
    }

    function rebuildAndRerunNetwork() {
        const gate = document.getElementById('gate-select').value;
        const tableData = getTruthTableData(gate);
        const inputCount = tableData.length > 0 ? tableData[0].inputs.length : 1;
        const hiddenLayerCounts = getHiddenLayerNeuronCounts();

        initializeNetwork(inputCount, hiddenLayerCounts);
        updateTruthTable(); // This is needed to reset the output column
        updateCustomInputControls();
        runNetwork();
    }

    // --- INITIALIZATION ---
    function init() {
        try {
            // Explicitly set the initial state to ensure consistency.
            // The default gate is 'not', which requires 1 input.
            const initialGate = 'not';
            document.getElementById('gate-select').value = initialGate;

            const initialTableData = getTruthTableData(initialGate);
            const initialInputCount = initialTableData[0].inputs.length;

            initializeNetwork(initialInputCount);
            setupEventListeners();
            updateTruthTable();
            updateCustomInputControls();
            runNetwork();

            window.addEventListener('resize', resizeCanvas);
            resizeCanvas();
        } catch (error) {
            console.error("Error during initialization:", error);
        }
    }

    init();
});
