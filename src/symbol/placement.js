// @flow

import CollisionIndex from './collision_index';
import EXTENT from '../data/extent';
import * as symbolSize from './symbol_size';
import * as projection from './projection';
import { getTextboxScale, getAnchorJustification } from './symbol_layout';
import { getAnchorAlignment } from './shaping';
import symbolLayerProperties from '../style/style_layer/symbol_style_layer_properties';
import assert from 'assert';
import pixelsToTileUnits from '../source/pixels_to_tile_units';
import {warnOnce} from '../util/util';
import type Transform from '../geo/transform';
import type StyleLayer from '../style/style_layer';

import type Tile from '../source/tile';
import type SymbolBucket, { SingleCollisionBox } from '../data/bucket/symbol_bucket';
import type {mat4} from 'gl-matrix';
import type {CollisionBoxArray, CollisionVertexArray, SymbolInstance} from '../data/array_types';
import type FeatureIndex from '../data/feature_index';
import type {OverscaledTileID} from '../source/tile_id';

class OpacityState {
    opacity: number;
    placed: boolean;
    constructor(prevState: ?OpacityState, increment: number, placed: boolean, skipFade: ?boolean) {
        if (prevState) {
            this.opacity = Math.max(0, Math.min(1, prevState.opacity + (prevState.placed ? increment : -increment)));
        } else {
            this.opacity = (skipFade && placed) ? 1 : 0;
        }
        this.placed = placed;
    }
    isHidden() {
        return this.opacity === 0 && !this.placed;
    }
}

class JointOpacityState {
    text: OpacityState;
    icon: OpacityState;
    constructor(prevState: ?JointOpacityState, increment: number, placedText: boolean, placedIcon: boolean, skipFade: ?boolean) {
        this.text = new OpacityState(prevState ? prevState.text : null, increment, placedText, skipFade);
        this.icon = new OpacityState(prevState ? prevState.icon : null, increment, placedIcon, skipFade);
    }
    isHidden() {
        return this.text.isHidden() && this.icon.isHidden();
    }
}

class JointPlacement {
    text: boolean;
    icon: boolean;
    // skipFade = outside viewport, but within CollisionIndex::viewportPadding px of the edge
    // Because these symbols aren't onscreen yet, we can skip the "fade in" animation,
    // and if a subsequent viewport change brings them into view, they'll be fully
    // visible right away.
    skipFade: boolean;
    constructor(text: boolean, icon: boolean, skipFade: boolean) {
        this.text = text;
        this.icon = icon;
        this.skipFade = skipFade;
    }
}

function shiftDynamicCollisionBox(collisionBox: SingleCollisionBox,
                                  textBoxScale: number,
                                  shiftX: number, shiftY: number,
                                  offset: [number, number]) {
    const {x1, x2, y1, y2, anchorPointX, anchorPointY} = collisionBox;
    // offset unit is ems, so we need to convert it to tile pixel units by mutilpying it by textBoxScale
    return {
        x1: x1 + shiftX + offset[0] * textBoxScale,
        y1: y1 + shiftY + offset[1] * textBoxScale,
        x2: x2 + shiftX + offset[0] * textBoxScale,
        y2: y2 + shiftY + offset[1] * textBoxScale,
        // symbol anchor point stays the same regardless of text-anchor
        anchorPointX,
        anchorPointY
    };
}

export class RetainedQueryData {
    bucketInstanceId: number;
    featureIndex: FeatureIndex;
    sourceLayerIndex: number;
    bucketIndex: number;
    tileID: OverscaledTileID;
    featureSortOrder: ?Array<number>
    constructor(bucketInstanceId: number,
                featureIndex: FeatureIndex,
                sourceLayerIndex: number,
                bucketIndex: number,
                tileID: OverscaledTileID) {
        this.bucketInstanceId = bucketInstanceId;
        this.featureIndex = featureIndex;
        this.sourceLayerIndex = sourceLayerIndex;
        this.bucketIndex = bucketIndex;
        this.tileID = tileID;
    }
}


export const AUTO_DYNAMIC_PLACEMENT = [
    "center",
    "top",
    "bottom",
    "left",
    "right",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right"
];

class CollisionGroups {
    collisionGroups: { [groupName: string]: { ID: number, predicate?: any }};
    maxGroupID: number;
    crossSourceCollisions: boolean;

    constructor(crossSourceCollisions: boolean) {
        this.crossSourceCollisions = crossSourceCollisions;
        this.maxGroupID = 0;
        this.collisionGroups = {};
    }

    get(sourceID: string) {
        // The predicate/groupID mechanism allows for arbitrary grouping,
        // but the current interface defines one source == one group when
        // crossSourceCollisions == true.
        if (!this.crossSourceCollisions) {
            if (!this.collisionGroups[sourceID]) {
                const nextGroupID = ++this.maxGroupID;
                this.collisionGroups[sourceID] = {
                    ID: nextGroupID,
                    predicate: (key) => {
                        return key.collisionGroupID === nextGroupID;
                    }
                };
            }
            return this.collisionGroups[sourceID];
        } else {
            return { ID: 0, predicate: null };
        }
    }
}

type DynamicTextOffsets = {
    // [shiftX, shiftY]
    right: [number, number],
    center: [number, number],
    left: [number, number]
};

function getDynamicOffset(anchor, radialOffset) {
    let x = 0, y = 0;
    // solve for r where r^2 + r^2 = radialOffset^2
    const hypotenuse = radialOffset / Math.sqrt(2);

    switch (anchor) {
    case 'top-right':
    case 'top-left':
        y = hypotenuse;
        break;
    case 'bottom-right':
    case 'bottom-left':
        y = -hypotenuse;
        break;
    case 'bottom':
        y = -radialOffset;
        break;
    case 'top':
        y = radialOffset;
        break;
    }

    switch (anchor) {
    case 'top-right':
    case 'bottom-right':
        x = -hypotenuse;
        break;
    case 'top-left':
    case 'bottom-left':
        x = hypotenuse;
        break;
    case 'left':
        x = radialOffset;
        break;
    case 'right':
        x = -radialOffset;
        break;
    }

    return [x, y];
}

export class Placement {
    transform: Transform;
    collisionIndex: CollisionIndex;
    placements: { [string | number]: JointPlacement };
    opacities: { [string | number]: JointOpacityState };
    dynamicOffsets: {[string | number]: DynamicTextOffsets };
    commitTime: number;
    lastPlacementChangeTime: number;
    stale: boolean;
    fadeDuration: number;
    retainedQueryData: {[number]: RetainedQueryData};
    collisionGroups: CollisionGroups;

    constructor(transform: Transform, fadeDuration: number, crossSourceCollisions: boolean) {
        this.transform = transform.clone();
        this.collisionIndex = new CollisionIndex(this.transform);
        this.placements = {};
        this.opacities = {};
        this.dynamicOffsets = {};
        this.stale = false;
        this.commitTime = 0;
        this.fadeDuration = fadeDuration;
        this.retainedQueryData = {};
        this.collisionGroups = new CollisionGroups(crossSourceCollisions);
    }

    placeLayerTile(styleLayer: StyleLayer, tile: Tile, showCollisionBoxes: boolean, seenCrossTileIDs: { [string | number]: boolean }) {
        const symbolBucket = ((tile.getBucket(styleLayer): any): SymbolBucket);
        const bucketFeatureIndex = tile.latestFeatureIndex;
        if (!symbolBucket || !bucketFeatureIndex || styleLayer.id !== symbolBucket.layerIds[0])
            return;

        const collisionBoxArray = tile.collisionBoxArray;

        const layout = symbolBucket.layers[0].layout;

        const scale = Math.pow(2, this.transform.zoom - tile.tileID.overscaledZ);
        const textPixelRatio = tile.tileSize / EXTENT;

        const posMatrix = this.transform.calculatePosMatrix(tile.tileID.toUnwrapped());

        const textLabelPlaneMatrix = projection.getLabelPlaneMatrix(posMatrix,
                layout.get('text-pitch-alignment') === 'map',
                layout.get('text-rotation-alignment') === 'map',
                this.transform,
                pixelsToTileUnits(tile, 1, this.transform.zoom));

        const iconLabelPlaneMatrix = projection.getLabelPlaneMatrix(posMatrix,
                layout.get('icon-pitch-alignment') === 'map',
                layout.get('icon-rotation-alignment') === 'map',
                this.transform,
                pixelsToTileUnits(tile, 1, this.transform.zoom));

        // As long as this placement lives, we have to hold onto this bucket's
        // matching FeatureIndex/data for querying purposes
        this.retainedQueryData[symbolBucket.bucketInstanceId] = new RetainedQueryData(
            symbolBucket.bucketInstanceId,
            bucketFeatureIndex,
            symbolBucket.sourceLayerIndex,
            symbolBucket.index,
            tile.tileID
        );
        this.placeLayerBucket(symbolBucket, posMatrix, textLabelPlaneMatrix, iconLabelPlaneMatrix, scale, textPixelRatio,
                showCollisionBoxes, tile.holdingForFade(), seenCrossTileIDs, collisionBoxArray);
    }

    placeLayerBucket(bucket: SymbolBucket, posMatrix: mat4, textLabelPlaneMatrix: mat4, iconLabelPlaneMatrix: mat4,
            scale: number, textPixelRatio: number, showCollisionBoxes: boolean, holdingForFade: boolean, seenCrossTileIDs: { [string | number]: boolean },
            collisionBoxArray: ?CollisionBoxArray) {
        const layout = bucket.layers[0].layout;
        const partiallyEvaluatedTextSize = symbolSize.evaluateSizeForZoom(bucket.textSizeData, this.transform.zoom, symbolLayerProperties.layout.properties['text-size']);
        const textOptional = layout.get('text-optional');
        const iconOptional = layout.get('icon-optional');
        const textAllowOverlap = layout.get('text-allow-overlap');
        const iconAllowOverlap = layout.get('icon-allow-overlap');
        // This logic is similar to the "defaultOpacityState" logic below in updateBucketOpacities
        // If we know a symbol is always supposed to show, force it to be marked visible even if
        // it wasn't placed into the collision index (because some or all of it was outside the range
        // of the collision grid).
        // There is a subtle edge case here we're accepting:
        //  Symbol A has text-allow-overlap: true, icon-allow-overlap: true, icon-optional: false
        //  A's icon is outside the grid, so doesn't get placed
        //  A's text would be inside grid, but doesn't get placed because of icon-optional: false
        //  We still show A because of the allow-overlap settings.
        //  Symbol B has allow-overlap: false, and gets placed where A's text would be
        //  On panning in, there is a short period when Symbol B and Symbol A will overlap
        //  This is the reverse of our normal policy of "fade in on pan", but should look like any other
        //  collision and hopefully not be too noticeable.
        // See https://github.com/mapbox/mapbox-gl-js/issues/7172
        const alwaysShowText = textAllowOverlap && (iconAllowOverlap || !bucket.hasIconData() || iconOptional);
        const alwaysShowIcon = iconAllowOverlap && (textAllowOverlap || !bucket.hasTextData() || textOptional);

        const collisionGroup = this.collisionGroups.get(bucket.sourceID);

        if (!bucket.collisionArrays && collisionBoxArray) {
            bucket.deserializeCollisionBoxes(collisionBoxArray);
        }

        for (let i = 0; i < bucket.symbolInstances.length; i++) {
            const symbolInstance = bucket.symbolInstances.get(i);
            if (!seenCrossTileIDs[symbolInstance.crossTileID]) {
                if (holdingForFade) {
                    // Mark all symbols from this tile as "not placed", but don't add to seenCrossTileIDs, because we don't
                    // know yet if we have a duplicate in a parent tile that _should_ be placed.
                    this.placements[symbolInstance.crossTileID] = new JointPlacement(false, false, false);
                    continue;
                }

                let placeText = false;
                let placeIcon = false;
                let offscreen = true;

                let placedGlyphBoxes = null;
                let placedGlyphCircles = null;
                let placedIconBoxes = null;
                let shiftedCollisionBox = null;
                let textFeatureIndex = 0;
                let iconFeatureIndex = 0;

                const collisionArrays = bucket.collisionArrays[i];

                if (collisionArrays.textFeatureIndex) {
                    textFeatureIndex = collisionArrays.textFeatureIndex;
                }

                const {
                    rightJustifiedTextSymbolIndex,
                    leftJustifiedTextSymbolIndex,
                    centerJustifiedTextSymbolIndex,
                    layoutTextSize,
                    dynamicTextOffset
                } = symbolInstance;
                // justify right = 1, left = 0, center = 0.5
                const justifications = {
                    "left": leftJustifiedTextSymbolIndex,
                    "center": centerJustifiedTextSymbolIndex,
                    "right": rightJustifiedTextSymbolIndex
                };

                if (collisionArrays.textBox && !layout.get('dynamic-text-anchor')) {
                    placedGlyphBoxes = this.collisionIndex.placeCollisionBox(collisionArrays.textBox,
                            layout.get('text-allow-overlap'), textPixelRatio, posMatrix, collisionGroup.predicate);
                    placeText = placedGlyphBoxes.box.length > 0;
                } else if (collisionArrays.textBox) {
                    const textBox = collisionArrays.textBox;
                    const textBoxScale = getTextboxScale(bucket.tilePixelRatio, layoutTextSize);
                    const dynamicAnchors = layout.get('dynamic-text-anchor');
                    const anchors = dynamicAnchors[0] === "auto" ? AUTO_DYNAMIC_PLACEMENT : dynamicAnchors;
                    for (const anchor of anchors) {
                        // Skip center placement on auto mode if there is an icon for this feature
                        if (collisionArrays.iconBox && dynamicAnchors[0] === "auto" && anchor === "center") continue;
                        // Auto is not valid as any but the first element of the `dynamic-placmene`
                        if (anchor === "auto") {
                            warnOnce("Auto is not valid as any but the first element of the `dynamic-text-anchor` array.");
                            continue;
                        }
                        const justification = getAnchorJustification(anchor);
                        const justifiedPlacedSymbol = justifications[justification];
                        if (justifiedPlacedSymbol < 0) continue;

                        const {horizontalAlign, verticalAlign} = getAnchorAlignment(anchor);
                        const shiftX = -horizontalAlign * (textBox.x2 - textBox.x1);
                        const shiftY = -verticalAlign * (textBox.y2 - textBox. y1);
                        const offset = dynamicTextOffset ? getDynamicOffset(anchor, dynamicTextOffset) : [0, 0];

                        if (collisionArrays.textBox) {
                            shiftedCollisionBox = shiftDynamicCollisionBox(collisionArrays.textBox, textBoxScale, shiftX, shiftY, offset);
                            placedGlyphBoxes = this.collisionIndex.placeCollisionBox(shiftedCollisionBox,
                                    layout.get('text-allow-overlap'), textPixelRatio, posMatrix, collisionGroup.predicate);
                            placeText = placedGlyphBoxes.box.length > 0;

                            if (placeText) {
                                bucket.text.placedSymbolArray.get(justifiedPlacedSymbol).shiftX = shiftX / textBoxScale + offset[0];
                                bucket.text.placedSymbolArray.get(justifiedPlacedSymbol).shiftY = shiftY / textBoxScale + offset[1];
                                this.hideUnplacedJustifications(bucket, justification, symbolInstance);
                                break;
                            }
                        }
                    }
                }

                const alongLineJustification = [leftJustifiedTextSymbolIndex, centerJustifiedTextSymbolIndex, rightJustifiedTextSymbolIndex].filter(i => i >= 0);
                offscreen = placedGlyphBoxes && placedGlyphBoxes.offscreen;
                const textCircles = collisionArrays.textCircles;
                if (textCircles) {
                    const placedSymbol = bucket.text.placedSymbolArray.get(alongLineJustification[0]);
                    const fontSize = symbolSize.evaluateSizeForFeature(bucket.textSizeData, partiallyEvaluatedTextSize, placedSymbol);
                    placedGlyphCircles = this.collisionIndex.placeCollisionCircles(textCircles,
                            layout.get('text-allow-overlap'),
                            scale,
                            textPixelRatio,
                            placedSymbol,
                            bucket.lineVertexArray,
                            bucket.glyphOffsetArray,
                            fontSize,
                            posMatrix,
                            textLabelPlaneMatrix,
                            showCollisionBoxes,
                            layout.get('text-pitch-alignment') === 'map',
                            collisionGroup.predicate);
                    // If text-allow-overlap is set, force "placedCircles" to true
                    // In theory there should always be at least one circle placed
                    // in this case, but for now quirks in text-anchor
                    // and text-offset may prevent that from being true.
                    placeText = layout.get('text-allow-overlap') || placedGlyphCircles.circles.length > 0;
                    offscreen = offscreen && placedGlyphCircles.offscreen;
                }

                if (collisionArrays.iconFeatureIndex) {
                    iconFeatureIndex = collisionArrays.iconFeatureIndex;
                }
                if (collisionArrays.iconBox) {
                    placedIconBoxes = this.collisionIndex.placeCollisionBox(collisionArrays.iconBox,
                            layout.get('icon-allow-overlap'), textPixelRatio, posMatrix, collisionGroup.predicate);
                    placeIcon = placedIconBoxes.box.length > 0;
                    offscreen = offscreen && placedIconBoxes.offscreen;
                }

                const iconWithoutText = textOptional || (
                    symbolInstance.numCenterJustifiedGlyphVertices === 0 &&
                                        symbolInstance.numRightJustifiedGlyphVertices === 0 &&
                                        symbolInstance.numLeftJustifiedGlyphVertices === 0 &&
                                        symbolInstance.numVerticalGlyphVertices === 0);
                const textWithoutIcon = iconOptional || symbolInstance.numIconVertices === 0;

                // Combine the scales for icons and text.
                if (!iconWithoutText && !textWithoutIcon) {
                    placeIcon = placeText = placeIcon && placeText;
                } else if (!textWithoutIcon) {
                    placeText = placeIcon && placeText;
                } else if (!iconWithoutText) {
                    placeIcon = placeIcon && placeText;
                }

                if (placeText && placedGlyphBoxes) {
                    this.collisionIndex.insertCollisionBox(placedGlyphBoxes.box, layout.get('text-ignore-placement'),
                            bucket.bucketInstanceId, textFeatureIndex, collisionGroup.ID);
                }
                if (placeIcon && placedIconBoxes) {
                    this.collisionIndex.insertCollisionBox(placedIconBoxes.box, layout.get('icon-ignore-placement'),
                            bucket.bucketInstanceId, iconFeatureIndex, collisionGroup.ID);
                }
                if (placeText && placedGlyphCircles) {
                    this.collisionIndex.insertCollisionCircles(placedGlyphCircles.circles, layout.get('text-ignore-placement'),
                            bucket.bucketInstanceId, textFeatureIndex, collisionGroup.ID);
                }

                assert(symbolInstance.crossTileID !== 0);
                assert(bucket.bucketInstanceId !== 0);
                this.placements[symbolInstance.crossTileID] = new JointPlacement(placeText || alwaysShowText, placeIcon || alwaysShowIcon, offscreen || bucket.justReloaded);

                seenCrossTileIDs[symbolInstance.crossTileID] = true;
            }
        }

        bucket.justReloaded = false;
    }

    hideUnplacedJustifications(bucket: SymbolBucket, placedJustification: string, symbolInstance: SymbolInstance) {
        const { leftJustifiedTextSymbolIndex,
            rightJustifiedTextSymbolIndex,
            centerJustifiedTextSymbolIndex } = symbolInstance;
        const instances = [
            {justification: "left", index: leftJustifiedTextSymbolIndex},
            {justification: "center", index: centerJustifiedTextSymbolIndex},
            {justification: "right", index: rightJustifiedTextSymbolIndex}
        ];
        for (const i of instances) {
            if (i.index < 0) continue;
            if (i.justification !== placedJustification) {
                // shift offscreen
                bucket.text.placedSymbolArray.get(i.index).shiftX = -Infinity;
            }
        }
    }

    commit(prevPlacement: ?Placement, now: number): void {
        this.commitTime = now;

        let placementChanged = false;

        const increment = (prevPlacement && this.fadeDuration !== 0) ?
            (this.commitTime - prevPlacement.commitTime) / this.fadeDuration :
            1;

        const prevOpacities = prevPlacement ? prevPlacement.opacities : {};
        // add the opacities from the current placement, and copy their current values from the previous placement
        for (const crossTileID in this.placements) {
            const jointPlacement = this.placements[crossTileID];
            const prevOpacity = prevOpacities[crossTileID];
            if (prevOpacity) {
                this.opacities[crossTileID] = new JointOpacityState(prevOpacity, increment, jointPlacement.text, jointPlacement.icon);
                placementChanged = placementChanged ||
                    jointPlacement.text !== prevOpacity.text.placed ||
                    jointPlacement.icon !== prevOpacity.icon.placed;
            } else {
                this.opacities[crossTileID] = new JointOpacityState(null, increment, jointPlacement.text, jointPlacement.icon, jointPlacement.skipFade);
                placementChanged = placementChanged || jointPlacement.text || jointPlacement.icon;
            }
        }

        // copy and update values from the previous placement that aren't in the current placement but haven't finished fading
        for (const crossTileID in prevOpacities) {
            const prevOpacity = prevOpacities[crossTileID];
            if (!this.opacities[crossTileID]) {
                const jointOpacity = new JointOpacityState(prevOpacity, increment, false, false);
                if (!jointOpacity.isHidden()) {
                    this.opacities[crossTileID] = jointOpacity;
                    placementChanged = placementChanged || prevOpacity.text.placed || prevOpacity.icon.placed;
                }
            }
        }

        // this.lastPlacementChangeTime is the time of the last commit() that
        // resulted in a placement change -- in other words, the start time of
        // the last symbol fade animation
        assert(!prevPlacement || prevPlacement.lastPlacementChangeTime !== undefined);
        if (placementChanged) {
            this.lastPlacementChangeTime = now;
        } else if (typeof this.lastPlacementChangeTime !== 'number') {
            this.lastPlacementChangeTime = prevPlacement ? prevPlacement.lastPlacementChangeTime : now;
        }
    }

    updateLayerOpacities(styleLayer: StyleLayer, tiles: Array<Tile>) {
        const seenCrossTileIDs = {};
        for (const tile of tiles) {
            const symbolBucket = ((tile.getBucket(styleLayer): any): SymbolBucket);
            if (symbolBucket && tile.latestFeatureIndex && styleLayer.id === symbolBucket.layerIds[0]) {
                this.updateBucketOpacities(symbolBucket, seenCrossTileIDs, tile.collisionBoxArray, tile.tileID.overscaledZ);
            }
        }
    }

    shiftPlacedSymbols(bucket: SymbolBucket, placedSymbolIndex: number, isHidden: boolean, dynamicOffset: ?[number, number]) {
        if (placedSymbolIndex > -1) {
            bucket.text.placedSymbolArray.get(placedSymbolIndex).hidden = isHidden ? 1 : 0;
            if (!isHidden && dynamicOffset) {
                bucket.text.placedSymbolArray.get(placedSymbolIndex).shiftX = dynamicOffset[0];
                bucket.text.placedSymbolArray.get(placedSymbolIndex).shiftY = dynamicOffset[1];
            }
        }
    }

    updateBucketOpacities(bucket: SymbolBucket, seenCrossTileIDs: { [string | number]: boolean }, collisionBoxArray: ?CollisionBoxArray, overscaledZ: number) {
        if (bucket.hasTextData()) bucket.text.opacityVertexArray.clear();
        if (bucket.hasIconData()) bucket.icon.opacityVertexArray.clear();
        if (bucket.hasCollisionBoxData()) bucket.collisionBox.collisionVertexArray.clear();
        if (bucket.hasCollisionCircleData()) bucket.collisionCircle.collisionVertexArray.clear();

        const layout = bucket.layers[0].layout;
        const duplicateOpacityState = new JointOpacityState(null, 0, false, false, true);
        const duplicateDynamicShifts = {
            right: [-Infinity, -Infinity],
            center: [-Infinity, -Infinity],
            left: [-Infinity, -Infinity]
        };
        const textAllowOverlap = layout.get('text-allow-overlap');
        const iconAllowOverlap = layout.get('icon-allow-overlap');
        const dynamicPlacement = layout.get('dynamic-text-anchor');
        // If allow-overlap is true, we can show symbols before placement runs on them
        // But we have to wait for placement if we potentially depend on a paired icon/text
        // with allow-overlap: false.
        // See https://github.com/mapbox/mapbox-gl-js/issues/7032
        const defaultOpacityState = new JointOpacityState(null, 0,
                textAllowOverlap && (iconAllowOverlap || !bucket.hasIconData() || layout.get('icon-optional')),
                iconAllowOverlap && (textAllowOverlap || !bucket.hasTextData() || layout.get('text-optional')),
                true);

        if (!bucket.collisionArrays && collisionBoxArray && (bucket.hasCollisionBoxData() || bucket.hasCollisionCircleData())) {
            bucket.deserializeCollisionBoxes(collisionBoxArray);
        }

        for (let s = 0; s < bucket.symbolInstances.length; s++) {
            const symbolInstance = bucket.symbolInstances.get(s);
            const {
                numCenterJustifiedGlyphVertices,
                numRightJustifiedGlyphVertices,
                numLeftJustifiedGlyphVertices,
                numVerticalGlyphVertices,
                rightJustifiedTextSymbolIndex,
                centerJustifiedTextSymbolIndex,
                leftJustifiedTextSymbolIndex,
                verticalPlacedTextSymbolIndex,
                crossTileID,
                layoutTextSize
            } = symbolInstance;

            const isDuplicate = seenCrossTileIDs[crossTileID];

            let opacityState = this.opacities[crossTileID];
            let dynamicOffsets = this.dynamicOffsets[crossTileID];
            if (isDuplicate) {
                opacityState = duplicateOpacityState;
                dynamicOffsets = duplicateDynamicShifts;
            } else if (!opacityState) {
                opacityState = defaultOpacityState;
                // store the state so that future placements use it as a starting point
                this.opacities[crossTileID] = opacityState;
            }

            if (!dynamicOffsets && dynamicPlacement) {
                const placedSymbols = [leftJustifiedTextSymbolIndex, centerJustifiedTextSymbolIndex, rightJustifiedTextSymbolIndex].map(i => bucket.text.placedSymbolArray.get(i));
                dynamicOffsets = {
                    left: [placedSymbols[0].shiftX, placedSymbols[0].shiftY],
                    center: [placedSymbols[1].shiftX, placedSymbols[1].shiftY],
                    right: [placedSymbols[2].shiftX, placedSymbols[2].shiftY]
                };
                this.dynamicOffsets[crossTileID] = dynamicOffsets;
            }

            seenCrossTileIDs[crossTileID] = true;

            const hasText = numCenterJustifiedGlyphVertices > 0 ||
                            numRightJustifiedGlyphVertices > 0 ||
                            numLeftJustifiedGlyphVertices > 0 ||
                            numVerticalGlyphVertices > 0;

            const hasIcon = symbolInstance.numIconVertices > 0;

            if (hasText) {
                const packedOpacity = packOpacity(opacityState.text);
                // Vertical text fades in/out on collision the same way as corresponding
                // horizontal text. Switch between vertical/horizontal should be instantaneous
                const opacityEntryCount = (numCenterJustifiedGlyphVertices + numRightJustifiedGlyphVertices +
                                           numLeftJustifiedGlyphVertices + numVerticalGlyphVertices) / 4;

                for (let i = 0; i < opacityEntryCount; i++) {
                    bucket.text.opacityVertexArray.emplaceBack(packedOpacity);
                }
                // If this label is completely faded, mark it so that we don't have to calculate
                // its position at render time. If this layer has dynamic placement, shift the various
                // symbol instances appropriately so that symbols from buckets that have yet to be placed
                // offset appropriately.
                const hide = opacityState.text.isHidden();
                this.shiftPlacedSymbols(bucket, rightJustifiedTextSymbolIndex, hide, dynamicPlacement ? dynamicOffsets.right : undefined);
                this.shiftPlacedSymbols(bucket, centerJustifiedTextSymbolIndex, hide, dynamicPlacement ? dynamicOffsets.center : undefined);
                this.shiftPlacedSymbols(bucket, leftJustifiedTextSymbolIndex, hide, dynamicPlacement ? dynamicOffsets.left : undefined);
                this.shiftPlacedSymbols(bucket, verticalPlacedTextSymbolIndex, hide);
            }

            if (hasIcon) {
                const packedOpacity = packOpacity(opacityState.icon);
                for (let i = 0; i < symbolInstance.numIconVertices / 4; i++) {
                    bucket.icon.opacityVertexArray.emplaceBack(packedOpacity);
                }
                bucket.icon.placedSymbolArray.get(s).hidden =
                    (opacityState.icon.isHidden(): any);
            }


            if (bucket.hasCollisionBoxData() || bucket.hasCollisionCircleData()) {
                const collisionArrays = bucket.collisionArrays[s];
                if (collisionArrays) {
                    if (collisionArrays.textBox) {
                        let shiftX = 0, shiftY = 0;
                        if (dynamicPlacement && opacityState.text.placed) {
                            const textBoxScale = getTextboxScale(bucket.tilePixelRatio, layoutTextSize);
                            const placedShift = Object.keys(dynamicOffsets).map(k => dynamicOffsets[k]).filter(s => s[0] !== undefined && s[0] !== -Infinity);
                            if (placedShift.length) {
                                const shift = placedShift[0];
                                shiftX = (shift[0] * textBoxScale) / Math.pow(2, this.transform.zoom - overscaledZ);
                                shiftY = (shift[1] * textBoxScale) / Math.pow(2, this.transform.zoom - overscaledZ);
                            }
                        }

                        updateCollisionVertices(bucket.collisionBox.collisionVertexArray, opacityState.text.placed, false, shiftX, shiftY);
                    }

                    if (collisionArrays.iconBox) {
                        updateCollisionVertices(bucket.collisionBox.collisionVertexArray, opacityState.icon.placed, false);
                    }

                    const textCircles = collisionArrays.textCircles;
                    if (textCircles && bucket.hasCollisionCircleData()) {
                        for (let k = 0; k < textCircles.length; k += 5) {
                            const notUsed = isDuplicate || textCircles[k + 4] === 0;
                            updateCollisionVertices(bucket.collisionCircle.collisionVertexArray, opacityState.text.placed, notUsed);
                        }
                    }
                }
            }
        }

        bucket.sortFeatures(this.transform.angle);
        if (this.retainedQueryData[bucket.bucketInstanceId]) {
            this.retainedQueryData[bucket.bucketInstanceId].featureSortOrder = bucket.featureSortOrder;
        }

        if (bucket.hasTextData() && bucket.text.opacityVertexBuffer) {
            bucket.text.opacityVertexBuffer.updateData(bucket.text.opacityVertexArray);
        }
        if (bucket.hasIconData() && bucket.icon.opacityVertexBuffer) {
            bucket.icon.opacityVertexBuffer.updateData(bucket.icon.opacityVertexArray);
        }
        if (bucket.hasCollisionBoxData() && bucket.collisionBox.collisionVertexBuffer) {
            bucket.collisionBox.collisionVertexBuffer.updateData(bucket.collisionBox.collisionVertexArray);
        }
        if (bucket.hasCollisionCircleData() && bucket.collisionCircle.collisionVertexBuffer) {
            bucket.collisionCircle.collisionVertexBuffer.updateData(bucket.collisionCircle.collisionVertexArray);
        }

        assert(bucket.text.opacityVertexArray.length === bucket.text.layoutVertexArray.length / 4);
        assert(bucket.icon.opacityVertexArray.length === bucket.icon.layoutVertexArray.length / 4);
    }

    symbolFadeChange(now: number) {
        return this.fadeDuration === 0 ?
            1 :
            (now - this.commitTime) / this.fadeDuration;
    }

    hasTransitions(now: number) {
        return this.stale ||
            now - this.lastPlacementChangeTime < this.fadeDuration;
    }

    stillRecent(now: number) {
        return this.commitTime + this.fadeDuration > now;
    }

    setStale() {
        this.stale = true;
    }
}

function updateCollisionVertices(collisionVertexArray: CollisionVertexArray, placed: boolean, notUsed: boolean, shiftX?: number, shiftY?: number) {
    collisionVertexArray.emplaceBack(placed ? 1 : 0, notUsed ? 1 : 0, shiftX || 0, shiftY || 0);
    collisionVertexArray.emplaceBack(placed ? 1 : 0, notUsed ? 1 : 0, shiftX || 0, shiftY || 0);
    collisionVertexArray.emplaceBack(placed ? 1 : 0, notUsed ? 1 : 0, shiftX || 0, shiftY || 0);
    collisionVertexArray.emplaceBack(placed ? 1 : 0, notUsed ? 1 : 0, shiftX || 0, shiftY || 0);
}

// All four vertices for a glyph will have the same opacity state
// So we pack the opacity into a uint8, and then repeat it four times
// to make a single uint32 that we can upload for each glyph in the
// label.
const shift25 = Math.pow(2, 25);
const shift24 = Math.pow(2, 24);
const shift17 = Math.pow(2, 17);
const shift16 = Math.pow(2, 16);
const shift9 = Math.pow(2, 9);
const shift8 = Math.pow(2, 8);
const shift1 = Math.pow(2, 1);
function packOpacity(opacityState: OpacityState): number {
    if (opacityState.opacity === 0 && !opacityState.placed) {
        return 0;
    } else if (opacityState.opacity === 1 && opacityState.placed) {
        return 4294967295;
    }
    const targetBit = opacityState.placed ? 1 : 0;
    const opacityBits = Math.floor(opacityState.opacity * 127);
    return opacityBits * shift25 + targetBit * shift24 +
        opacityBits * shift17 + targetBit * shift16 +
        opacityBits * shift9 + targetBit * shift8 +
        opacityBits * shift1 + targetBit;
}
