// Copyright (c) 2015 - 2017 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// Handles tesselation of polygons with holes
// - 2D surfaces
// - 2D outlines
// - 3D surfaces (top and sides only)
// - 3D wireframes (not yet)
import * as Polygon from './polygon';
import {experimental} from '@deck.gl/core';
const {fillArray, fp64LowPart} = experimental;

// Maybe deck.gl or luma.gl needs to export this
function getPickingColor(index) {
  index++;
  return [index & 255, (index >> 8) & 255, (index >> 16) & 255];
}

const DEFAULT_COLOR = [0, 0, 0, 255]; // Black

// This class is set up to allow querying one attribute at a time
// the way the AttributeManager expects it
export class PolygonTesselator {
  constructor({polygons, IndexType}) {
    // Normalize all polygons
    polygons = polygons.map(polygon => Polygon.normalize(polygon));

    // Count all polygon vertices
    const pointCount = getPointCount(polygons);

    this.polygons = polygons;
    this.pointCount = pointCount;
    this.IndexType = IndexType;

    // TODO: dynamically decide IndexType in tesselator?
    // Check if the vertex count excedes index type limit
    if (IndexType === Uint16Array && pointCount > 65535) {
      throw new Error("Vertex count exceeds browser's limit");
    }

    this.attributes = {
      pickingColors: calculatePickingColors({polygons, pointCount})
    };
  }

  updatePositions({fp64, extruded}) {
    const {attributes, polygons, pointCount} = this;

    attributes.positions = attributes.positions || new Float32Array(pointCount * 3);
    attributes.nextPositions = attributes.nextPositions || new Float32Array(pointCount * 3);

    if (fp64) {
      // We only need x, y component
      attributes.positions64xyLow = attributes.positions64xyLow || new Float32Array(pointCount * 2);
      attributes.nextPositions64xyLow =
        attributes.nextPositions64xyLow || new Float32Array(pointCount * 2);
    }

    updatePositions({cache: attributes, polygons, extruded, fp64});
  }

  indices() {
    const {polygons, IndexType} = this;
    return calculateIndices({polygons, IndexType});
  }

  positions() {
    return this.attributes.positions;
  }
  positions64xyLow() {
    return this.attributes.positions64xyLow;
  }

  nextPositions() {
    return this.attributes.nextPositions;
  }
  nextPositions64xyLow() {
    return this.attributes.nextPositions64xyLow;
  }

  elevations({key = 'elevations', getElevation = x => 100} = {}) {
    const {attributes, polygons, pointCount} = this;
    const values = updateElevations({cache: attributes[key], polygons, pointCount, getElevation});
    attributes[key] = values;
    return values;
  }

  colors({key = 'colors', getColor = x => DEFAULT_COLOR} = {}) {
    const {attributes, polygons, pointCount} = this;
    const values = updateColors({cache: attributes[key], polygons, pointCount, getColor});
    attributes[key] = values;
    return values;
  }

  pickingColors() {
    return this.attributes.pickingColors;
  }
}

// Count number of points in a list of complex polygons
function getPointCount(polygons) {
  return polygons.reduce((points, polygon) => points + Polygon.getVertexCount(polygon), 0);
}

// COunt number of triangles in a list of complex polygons
function getTriangleCount(polygons) {
  return polygons.reduce((triangles, polygon) => triangles + Polygon.getTriangleCount(polygon), 0);
}

// Returns the offsets of each complex polygon in the combined array of all polygons
function getPolygonOffsets(polygons) {
  const offsets = new Array(polygons.length + 1);
  offsets[0] = 0;
  let offset = 0;
  polygons.forEach((polygon, i) => {
    offset += Polygon.getVertexCount(polygon);
    offsets[i + 1] = offset;
  });
  return offsets;
}

function calculateIndices({polygons, IndexType = Uint32Array}) {
  // Calculate length of index array (3 * number of triangles)
  const indexCount = 3 * getTriangleCount(polygons);
  const offsets = getPolygonOffsets(polygons);

  // Allocate the attribute
  const attribute = new IndexType(indexCount);

  // 1. get triangulated indices for the internal areas
  // 2. offset them by the number of indices in previous polygons
  let i = 0;
  polygons.forEach((polygon, polygonIndex) => {
    for (const index of Polygon.getSurfaceIndices(polygon)) {
      attribute[i++] = index + offsets[polygonIndex];
    }
  });

  return attribute;
}

function updatePositions({
  cache: {positions, positions64xyLow, nextPositions, nextPositions64xyLow},
  polygons,
  extruded,
  fp64
}) {
  // Flatten out all the vertices of all the sub subPolygons
  let i = 0;
  let nextI = 0;
  let startVertex = null;

  const pushStartVertex = (x, y, z, xLow, yLow) => {
    if (extruded) {
      // Save first vertex for setting nextPositions at the end of the loop
      startVertex = {x, y, z, xLow, yLow};
    }
  };

  const popStartVertex = () => {
    if (startVertex) {
      nextPositions[nextI * 3] = startVertex.x;
      nextPositions[nextI * 3 + 1] = startVertex.y;
      nextPositions[nextI * 3 + 2] = startVertex.z;
      if (fp64) {
        nextPositions64xyLow[nextI * 2] = startVertex.xLow;
        nextPositions64xyLow[nextI * 2 + 1] = startVertex.yLow;
      }
      nextI++;
    }
    startVertex = null;
  };

  polygons.forEach((polygon, polygonIndex) => {
    Polygon.forEachVertex(polygon, (vertex, vertexIndex) => {
      // eslint-disable-line
      const x = vertex[0];
      const y = vertex[1];
      const z = vertex[2] || 0;
      let xLow;
      let yLow;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      if (fp64) {
        xLow = fp64LowPart(x);
        yLow = fp64LowPart(y);
        positions64xyLow[i * 2] = xLow;
        positions64xyLow[i * 2 + 1] = yLow;
      }
      i++;

      if (extruded && vertexIndex > 0) {
        nextPositions[nextI * 3] = x;
        nextPositions[nextI * 3 + 1] = y;
        nextPositions[nextI * 3 + 2] = z;
        if (fp64) {
          nextPositions64xyLow[nextI * 2] = xLow;
          nextPositions64xyLow[nextI * 2 + 1] = yLow;
        }
        nextI++;
      }
      if (vertexIndex === 0) {
        popStartVertex();
        pushStartVertex(x, y, z, xLow, yLow);
      }
    });
  });
  popStartVertex();
}

function updateElevations({cache, polygons, pointCount, getElevation}) {
  const elevations = cache || new Float32Array(pointCount);
  let i = 0;
  polygons.forEach((complexPolygon, polygonIndex) => {
    // Calculate polygon color
    const height = getElevation(polygonIndex);

    const vertexCount = Polygon.getVertexCount(complexPolygon);
    fillArray({target: elevations, source: [height], start: i, count: vertexCount});
    i += vertexCount;
  });
  return elevations;
}

function updateColors({cache, polygons, pointCount, getColor}) {
  const colors = cache || new Uint8ClampedArray(pointCount * 4);
  let i = 0;
  polygons.forEach((complexPolygon, polygonIndex) => {
    // Calculate polygon color
    const color = getColor(polygonIndex);
    if (isNaN(color[3])) {
      color[3] = 255;
    }

    const vertexCount = Polygon.getVertexCount(complexPolygon);
    fillArray({target: colors, source: color, start: i, count: vertexCount});
    i += color.length * vertexCount;
  });
  return colors;
}

function calculatePickingColors({polygons, pointCount}) {
  const attribute = new Uint8ClampedArray(pointCount * 3);
  let i = 0;
  polygons.forEach((complexPolygon, polygonIndex) => {
    const color = getPickingColor(polygonIndex);
    const vertexCount = Polygon.getVertexCount(complexPolygon);
    fillArray({target: attribute, source: color, start: i, count: vertexCount});
    i += color.length * vertexCount;
  });
  return attribute;
}
