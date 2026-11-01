// The model: a pure-pixel adjacency simulation with typed muxes, and the
// editing that goes with it, published as window.PixelogicModel for the
// view, the game and the UI. See ARCHITECTURE.md for how it fits together.
//
// Connectivity is adjacency: two orthogonally touching conductors are
// connected — there is no per-side wiring, but for a source, which joins
// only on the sides it is soldered to (its stubs). A crossing is a cell of
// its own, its two ways apart; a mux is six typed cells, each saying what
// it is and which way it faces.

import {
    FALLING, OFF, ON, Z, conductorCharge, isPosSource, isSource, sourceStubs, inferCrossings, muxCharge, isConductorId, isMuxId, isInsulatorId,
    DRAIN, MK_M, SEL_NO, isLed, isSwitch, isToggle, isWireId, isXover, ledIsOn, mirrorId, muxAuxOf, muxCellKind, muxChOf, muxKindOf, muxLead, rotateId,
    stripId, switchIsPressed, toggleIsOn, xoverH, xoverV,
} from './cells.js';
import {
    B, CELL_SIZE, activeBoard, cloneBoard, createBoard, getCell, idx, inBounds, isCrossoverAt, isLocked,
    lockedCells, setLockedCells, useBoard, withBoard,
} from './board.js';
import {
    chargeAt, flowField, primeCharges, resetBreaker, resetCharges, stepSimulation, tripped, watchTicks,
} from './sim.js';
import {
    blockAtCell, blockInfo, blockList, cellConnects, decapBlock, edgeAt, isProtected, isTerminalCell,
    removeBlock, ringViolations, setBlockOpen, topBlockOf, visibleBlockAt,
} from './blocks.js';
import {
    applyClearance, blockFits, clipCells, clipParts, clipPins, clipRing, clipShape, clipToJSON, decapClip, mirrorClipH,
    muxClearance, rotateClipCW, sanitizeClip,
} from './clips.js';
import {
    arrayClip, arrayPlan,
} from './arrays.js';
import {
    benchTerms, capPart, captureBlock, captureRect, fitPart, partInBounds,
} from './fit.js';
import {
    colorOfCell, crossWhereDrawn, crossable, joinAlong, muxLayout, paintCell, paintCells, recomputeRoles, setCrossing,
    setStub, setSwitch, setToggle, sourceCanJoin, stampMux, toggleAt,
} from './edit.js';
import {
    muxCount, parts, pendingLinkList, reaches,
} from './nets.js';
import {
    clearCells, clearGrid, clearRegion, copyRegion, expandForBorder, getStructuralSnapshot, muxBlob, growBy,
    growSnapshot, growTo, mirrorRegionH, pasteRegion, restoreStructuralSnapshot, rotateRegionCW,
} from './regions.js';
import {
    moveObject, moveObjects, objectAt,
} from './rearrange.js';
import {
    hugged, largestRect, outlineOf, piecesOf, withPockets,
} from './shape.js';
import {
    deserialize, serialize,
} from './io.js';

// The starting board, read.
recomputeRoles();

window.PixelogicModel = {
    CELL_SIZE,
    get GRID_W() { return B.w; },
    get GRID_H() { return B.h; },
    OFF, ON, FALLING, Z,
    idx, inBounds, getCell, paintCell, paintCells, colorOfCell, setSwitch, toggleAt, setToggle,
    expandForBorder, growTo, growBy, growSnapshot,
    isLocked, setLockedCells, lockedCells,
    createBoard, cloneBoard, activeBoard, useBoard, withBoard,
    // Raw cell array copy — the campaign verifier compares consecutive
    // ticks to decide a circuit has settled, which needs every bit of
    // live charge, not the structural (charge-stripped) snapshot.
    copyCells() { return B.cells.slice(); },
    // Puts back what copyCells copied — charge, lamps, switches — on the
    // board it was copied off, as it still is in everything else. False,
    // and nothing put back, if it is not: an edit since would be undone.
    setCharges(cells) {
        if (!cells || cells.length !== B.cells.length) return false;
        for (let i = 0; i < cells.length; i++) if (stripId(cells[i]) !== stripId(B.cells[i])) return false;
        B.cells.set(cells);
        return true;
    },
    isInsulatorId,
    isConductorId, conductorCharge,
    isXover, xoverV, xoverH, isCrossoverAt, cellConnects, reaches, parts, muxCount,
    pendingLinks: pendingLinkList,
    isWireId, muxCharge, isMuxId, muxLayout, stampMux, rotateId, mirrorId, muxCellKind, muxLead,
    // Where a mux's contact is, from its switch cell: 'no', 'nc', or 'open'
    // (its control floating); null for any other cell.
    muxContact(id) { return muxKindOf[id] !== MK_M ? null : muxChOf[id] === DRAIN ? 'open' : muxAuxOf[id] === SEL_NO ? 'no' : 'nc'; },
    isLed, ledIsOn, isSwitch, switchIsPressed, isToggle, toggleIsOn,
    // Sources: +V or -V, soldered on the sides their stubs say (a bit a
    // side, N E S W) — and a wire drawn onto one, a click on a side.
    isSource, isPosSource, sourceStubs, joinAlong, setStub, sourceCanJoin,
    get roles() { return B.roles; },
    stepSimulation, clearGrid, resetCharges, primeCharges, watchTicks, chargeAt, tripped, resetBreaker, flowField,
    getStructuralSnapshot, restoreStructuralSnapshot,
    copyRegion, clearRegion, clearCells, muxBlob, pasteRegion,
    rotateRegionCW, mirrorRegionH,
    isProtected, isTerminalCell, blockAtCell, visibleBlockAt, topBlockOf, blockList, blockInfo, edgeAt,
    clipRing, clipPins, clipParts, clipCells, clipShape, decapClip, ringViolations,
    // Shapes: pure geometry on lists of cells.
    outlineOf, largestRect, piecesOf, withPockets, hugged,
    // Crossings: cells of their own (see cells.js).
    crossable, setCrossing, crossWhereDrawn,
    // The board read by the rule crossings had before they were cells:
    // what an old save gets on loading, and what a board laid down cell by
    // cell under that rule (a test's) wants.
    inferCrossings() { inferCrossings(B.cells, B.w, B.h); recomputeRoles(); },
    setBlockOpen, removeBlock, decapBlock, captureBlock, fitPart, partInBounds, benchTerms, captureRect, capPart, blockFits, muxClearance, applyClearance,
    sanitizeClip, clipToJSON, rotateClipCW, mirrorClipH, arrayClip, arrayPlan,
    objectAt, moveObject, moveObjects,
    serialize, deserialize,
    get tickCount() { return B.tickCount; },
    recomputeRoles,
};
