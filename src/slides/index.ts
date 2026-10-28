import type { SlideDef } from './types';
import intro from './00-intro';
import overview from './01-overview';
import parse from './02-parse';
import layout from './03-layout';
import buffers from './04-buffers';
import input_layout from './05-input-layout';
import shaders from './06-shaders';
import pipeline_state from './07-pipeline-state';
import descriptors from './08-descriptors';
import commands from './09-commands';
import input_assembly from './10-input-assembly';
import vertex_shader from './11-vertex-shader';
import clipping from './12-clipping';
import viewport_culling from './13-viewport-culling';
import rasterization from './14-rasterization';
import fragment_shader from './15-fragment-shader';
import depth from './16-depth';
import blending from './17-blending';
import present from './18-present';
import summary from './19-summary';

/** Slide order. Each module default-exports one SlideDef. */
export const SLIDES: SlideDef[] = [
  intro,
  overview,
  parse,
  layout,
  buffers,
  input_layout,
  shaders,
  pipeline_state,
  descriptors,
  commands,
  input_assembly,
  vertex_shader,
  clipping,
  viewport_culling,
  rasterization,
  fragment_shader,
  depth,
  blending,
  present,
  summary,
];
