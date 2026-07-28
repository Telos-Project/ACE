# ACE Component Standard (Draft)

Proposed replacement and expansion for README §2.2.

---

## 2.2 - Components

All ACE component utilities shall have the tag "telos-ace", and their primary tag (index 0 of the
tags list, per APInt §2.2.4) shall determine the type of component they represent.

### 2.2.1 - Property Layout

A component utility's properties field shall contain up to two data objects:

- **data** — authored data points. Written by document authors and by scripts. Read by the engine.
- **state** — reflected data points. Written by the engine. Read by scripts. Never authored.

This division is normative and is referred to as the **authority rule**: the engine shall not write
to a data object except for consumable fields (§2.2.4), and no author or script shall write to a
state object. Engine writes to state are discarded from any script output.

The reconciler shall detect change by comparing only the `data`, `source`, and `content` fields of
components, and the `meta.data` field of entities. State is excluded from change detection.

Any state field not applicable to the current runtime shall be absent rather than null.

### 2.2.2 - Entities

Per G-Scene, an entity is a package and its components are its utilities. Entity-level properties
shall be placed in the `meta` field of the entity's properties (APInt §2.2.3), so that they apply
to the entity itself and do not bubble to its components.

    {
      "properties": {
        "meta": {
          "tags": ["enemy"],
          "data": { "position": [0, 1, 0] },
          "state": { }
        }
      },
      "utilities": { }
    }

Entity `meta.data`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| position | vec3 | [0,0,0] | Translation, relative to parent entity |
| rotation | vec3 \| vec4 | [0,0,0] | Length 3 = Euler XYZ in radians; length 4 = quaternion XYZW |
| scale | vec3 \| number | [1,1,1] | A single number scales uniformly |
| space | string | "parent" | "parent", "world", "screen", or "camera" |
| enabled | boolean | true | If false, the entity and its descendants are inert and unrendered |
| visible | boolean | true | If false, the entity and its descendants are unrendered but remain simulated |
| anchor | boolean | false | XR only. Requests a persistent spatial anchor at this pose |

Entity `meta.state`:

| Field | Type | Meaning |
|---|---|---|
| position | vec3 | Resolved world-space translation |
| rotation | vec4 | Resolved world-space orientation, quaternion |
| scale | vec3 | Resolved world-space scale |
| anchored | boolean | XR only. Whether an anchor was successfully established |

Entities with `space: "screen"` interpret position as normalized viewport coordinates, with
[0,0] at the lower-left and [1,1] at the upper-right, and z as sort order. Entities with
`space: "camera"` are positioned in the active camera's frame, in metres, so an entity at
[0, -0.34, -1] sits one metre ahead of the view and slightly below its centre. Both are the
mechanism by which 2D interfaces and heads-up displays are expressed; there is no separate
interface component family.

A camera-space entity is resolved against the active camera's *entity*, not against the camera
object, so that it inherits the document's forward axis rather than the engine's. Its descendants
follow it as they would anywhere else.

Text drawn in camera space is how a document presents a heads-up display. Adapters shall not
require a host to overlay one, since an element drawn above the rendering surface intercepts the
pointer events the document needs.

The engine writes the simulated pose of a physically driven entity to `meta.state`, never to
`meta.data`. Writing to `meta.data.position` or `meta.data.rotation` on an entity carrying a
dynamic body is a teleport: the value is consumed and cleared (§2.2.4). Such a teleport preserves
the body's velocity; the `teleport` field of the body component (§2.3.8) is the form that clears
it.

An entity carrying a dynamic body is simulated in world space and is detached from its parent's
transform for as long as the body exists. Its `meta.state` therefore reports the simulated pose
rather than a pose composed through the package hierarchy, and its descendants continue to follow
it. Adapters shall not attempt to compose a simulated pose with an authored parent transform.

### 2.2.3 - Conventions

**Coordinates.** Right-handed, Y-up, -Z forward. Adapters targeting left-handed engines shall
convert at the boundary.

Forward is -Z for every component that has a facing: a camera looks along its entity's -Z, a
directional light shines along it, and a spot light points along it. Where the underlying engine
disagrees — and camera conventions frequently do — the adapter shall correct for it rather than
leaving the document to compensate. A camera and a light on the same entity must face the same way,
and a control scheme derived from the document's forward axis must not read inverted.

Rotation about +Y follows the right-hand rule, so increasing yaw turns from -Z toward -X, which is
a turn to the left. Increasing pitch, a rotation about +X, tilts the view up.

**Units.** Distance in meters, mass in kilograms, time in seconds, angles in radians, force in
newtons.

**Colors.** Either a 3 or 4 element array of floats in [0,1] representing linear RGB(A), or a
string in "#rrggbb" or "#rrggbbaa" form representing sRGB. Adapters shall accept both.

**Sources.** Wherever a component takes a `source`, APInt 2.1.2 permits a list of locations in
order of preference. Adapters shall try each in turn, on the basis of whether a location can be
reached rather than on what its file extension suggests, and report failure only when every
candidate has failed. The component's state shall record which candidate succeeded. This is the mechanism by which a document depending on third-party asset hosts degrades
rather than breaks, and adapters shall implement it for every component that loads an asset, not
only for models.

**References.** A field documented as a *reference* holds an APInt element path, expressed either
as a list of strings or as a period-delimited string (APInt §2.1.4). References resolve against the
document root. Where a reference field may alternatively hold a literal asset location, the
reference form shall be wrapped in an object with a single key naming the target kind, e.g.
`{ "texture": "props.crate.albedo" }`, so that plain strings are always literal locations.

**Capabilities.** The `world` component's `requires` field lists capabilities the document depends
upon. An adapter which cannot supply a listed capability shall refuse the document rather than
render it partially.

### 2.2.4 - Consumable Fields

A small number of data fields express one-shot commands rather than persistent state. These are
**consumable**: the engine applies the value, then deletes the field from the document. This is the
sole exception to the authority rule, and the complete set is:

| Component | Field |
|---|---|
| entity (meta) | position, rotation, scale — when the entity carries a dynamic body |
| body | impulse, torque, teleport |
| audio | play, stop, seek |
| animation | play, stop, seek |
| controller | haptic |
| display | fullscreen, capture |
| query | (the whole component, when `continuous` is false) |

No other field is consumable, and adapters shall not extend this set.

### 2.2.5 - Simulation Stepping

Physics shall be advanced on the fixed timestep declared by `world.data.step`, and never on a
frame's measured duration. A host which reports elapsed time accumulates it and advances by whole
steps, capping the number of steps taken in any one frame so that a stall cannot compound. A host
which reports no frame timing advances exactly one step per frame.

The consequence, and the reason for the rule, is that a document is reproducible: the same document
advanced the same number of frames produces the same state, on any adapter and at any frame rate.
Documents driven by the Dynamic Declarative Simulation Pipeline depend on this, since an AI
rewriting the simulation reference must be able to predict the effect of the rewrite.

Adapters shall disable any automatic frame-rate-driven stepping supplied by the underlying engine.

### 2.2.6 - Order of a Frame

An adapter shall perform the following in order:

1. Write the reserved entity (§2.5) from the current runtime, replacing whatever it held.
2. Resolve the document into its component and entity set.
3. Run `start` scripts, then `update` scripts, applying each output before the next runs.
4. Reconcile: destroy departed components, create new ones, report changes.
5. Apply and clear consumable fields.
6. Apply entity transforms and reflect resolved poses.
7. Run `onUpdate` for every live component.
8. Flush reflected state into the document.
9. Render, then advance the simulation by §2.2.5.

An entity's transform shall be established when its node is created, not deferred to step 6, since
components created in step 4 — collision bodies above all — are constructed from it.

---

## 2.3 - Component Reference

### 2.3.1 - world

Scene-wide settings. Exactly one per document, in the root entity. Ignored elsewhere.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| gravity | vec3 | [0,-9.81,0] | Omit or set null to disable physics simulation entirely |
| background | color \| reference | [0,0,0,1] | A color, or `{ "texture": <path> }` referencing a cube texture, which becomes the skybox and the environment |
| horizon | number | 1000 | Skybox radius |
| ambient | color | [0,0,0] | Ambient light contribution |
| fog | object | — | `{ color, near, far }` |
| step | number | 1/60 | Fixed physics timestep; see §2.2.5 |
| substeps | integer | 1 | Physics solver substeps per step |
| requires | string[] | [] | Required capabilities: "physics", "xr-vr", "xr-ar", "audio", "hands" |

**state**

| Field | Type | Meaning |
|---|---|---|
| ready | boolean | All non-streaming assets in the document have resolved |
| capabilities | string[] | Capabilities the current runtime actually supplies |

### 2.3.2 - camera

Pose comes from the containing entity. A document with no enabled camera renders nothing.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| projection | string | "perspective" | "perspective" or "orthographic" |
| fov | number | 1.05 | Vertical field of view in radians, perspective only |
| size | number | 10 | Vertical extent in meters, orthographic only |
| near | number | 0.1 | |
| far | number | 1000 | |
| target | vec3 \| reference | — | World-space look-at point or entity. Overrides entity rotation while present |
| control | string | "none" | "none", "orbit", "fly", "first-person" — built-in navigation |
| speed | number | 1 | Movement rate for built-in navigation, m/s |
| viewport | vec4 | [0,0,1,1] | Normalized region of the display to render into |
| order | number | 0 | Render order for multi-camera setups; highest is composited last |
| clear | boolean | true | Whether to clear before rendering |
| xr | object | — | `{ mode, features, space }` — see below |

`xr.mode` is "vr" or "ar". `xr.features` is a list of optional session features, e.g.
"hit-test", "anchors", "planes", "hands", "light-estimation". `xr.space` is the reference space,
default "local-floor". Presence of the `xr` field is a request to present this camera in an
immersive session; absence means no session is requested. Sessions are never started implicitly.

**state**

| Field | Type | Meaning |
|---|---|---|
| supported | string[] | XR modes the runtime supports |
| presenting | boolean | An immersive session is active for this camera |
| pose | object | `{ position, rotation }` — head pose, XR only |
| views | object[] | Per-eye `{ position, rotation, fov }`, XR only |

### 2.3.3 - light

Direction is taken from the containing entity's forward axis (-Z). Position likewise.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| type | string | "directional" | "directional", "point", "spot", "ambient" |
| color | color | [1,1,1] | |
| intensity | number | 1 | |
| range | number | — | Falloff distance for point and spot |
| angle | number | 0.7 | Cone half-angle in radians, spot only |
| shadow | boolean \| object | false | `{ resolution, bias, near, far }` |

**state**

| Field | Type | Meaning |
|---|---|---|
| estimated | object | XR light estimation, when the "light-estimation" feature is active |

### 2.3.4 - mesh

Geometry, from one of three sources, in precedence order: `source` (a loaded model file),
`content` (manually specified geometry), or `data.shape` (a parametric primitive).

**Manual geometry** is supplied in the utility's `content` field. As a string, it is JSON of the
form `{ positions, normals, uvs, indices, colors }`, each a flat number array. As a number array,
it is a binary buffer whose layout is declared by `data.layout`.

**Heightmap terrain** is `shape: "heightmap"`, where `size` gives the horizontal extent, `elevation`
the vertical range, and `segments` the tessellation. The heights come either from a greyscale image
at `source`, or from `content` — as a string, JSON of the form `{ heights, resolution }` where each
height is a number in [0,1]; as a number array, raw RGBA samples whose grid is declared by
`data.resolution`. The two forms produce identical geometry, so a document authored against a
remote image can be tested against generated heights.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| shape | string | — | "box", "sphere", "plane", "cylinder", "capsule", "torus", "ground", "heightmap" |
| elevation | vec2 | [0, size.y] | Minimum and maximum height, heightmap only |
| resolution | vec2 | — | Sample grid dimensions when heights arrive as raw content |
| size | vec3 \| number | [1,1,1] | Dimensions; interpretation per shape |
| segments | integer \| vec2 | 16 | Tessellation |
| layout | object | — | Binary content layout: `{ stride, attributes: { position: {offset, type, count}, ... } }` |
| billboard | string | "none" | "none", "y", "full" — orients toward the active camera |
| shadow | object | — | `{ cast, receive }`, both boolean, both default true |
| instances | object[] | — | Per-instance `{ position, rotation, scale, color }` for instanced rendering |
| node | string | — | For loaded models, render only the named sub-node |

2D sprites are expressed as `shape: "plane"` with a material carrying a `region`. Sprite sheets
animate by patching that region.

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | |
| error | string | Present only on failure |
| bounds | object | `{ min, max }` in local space |
| nodes | string[] | Named sub-nodes of a loaded model |
| clips | string[] | Named animation clips available from a loaded model |
| materials | string[] | Named materials defined by a loaded model |

### 2.3.5 - material

Applies to the mesh component in the same entity. If an entity contains no material, a default
opaque white material is used. Materials are shared across entities by reference from
`data.maps` or by the links protocol (APInt §2.2.2).

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| color | color | [1,1,1,1] | Base color factor |
| metallic | number | 0 | |
| roughness | number | 1 | |
| emissive | color | [0,0,0] | |
| unlit | boolean | false | Bypass lighting entirely — the common case for 2D |
| blend | string | "opaque" | "opaque", "blend", "mask" |
| cutoff | number | 0.5 | Alpha threshold, mask only |
| side | string | "front" | "front", "back", "double" |
| region | vec4 | [0,0,1,1] | UV sub-rectangle — atlas and sprite-sheet addressing |
| tiling | vec2 | [1,1] | |
| offset | vec2 | [0,0] | |
| maps | object | — | `{ base, normal, metallic, roughness, emissive, occlusion }` |
| target | string | — | Named material slot of a loaded model to override |

Each value of `maps` is either a literal location string or a texture reference of the form
`{ "texture": <element path> }`.

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | All referenced maps have resolved |

### 2.3.6 - texture

An image, from `source` (a location) or `content` (manual pixel data). Manual pixel data is
supplied as a number array of raw samples in the format declared by `data.format`, with dimensions
declared by `data.size`; both are required in that case.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| format | string | "rgba8" | "rgba8", "rgb8", "r8", "rgba32f" |
| size | vec2 | — | Required for manual content |
| filter | string | "linear" | "linear" or "nearest" |
| wrap | string | "repeat" | "repeat", "clamp", "mirror" |
| mipmaps | boolean | true | |
| srgb | boolean | true | Whether to interpret samples as sRGB |
| flip | boolean | false | Flip vertically on load |
| cube | boolean | false | Treat as a cubemap. `source` is the common prefix of six face files; the adapter appends the face suffixes |
| faces | string[] | — | Explicit face file names, overriding the default suffixes |

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | |
| size | vec2 | Actual resolved dimensions |
| error | string | Present only on failure |

### 2.3.7 - text

The string to render is the utility's `content`.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| font | string \| reference | — | Font location, or reference to a texture for a bitmap font |
| size | number | 1 | Em height, in meters for world space, in normalized units for screen space |
| color | color | [1,1,1,1] | |
| align | string | "left" | "left", "center", "right" |
| anchor | string | "center" | Nine-point anchor: "top-left" through "bottom-right" |
| width | number | — | Wrap width; omit to disable wrapping |
| leading | number | 1.2 | Line height multiplier |
| billboard | string | "none" | As per mesh |

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | Font has resolved |
| bounds | object | `{ min, max }` of the laid-out text |

### 2.3.8 - body

Rigid-body dynamics for the containing entity. Requires the "physics" capability. An entity with a
body but no collider is simulated as a point mass.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| mode | string | "dynamic" | "dynamic", "kinematic", "static" |
| mass | number | 1 | Ignored for static and kinematic |
| velocity | vec3 | [0,0,0] | Linear velocity; writing sets it directly |
| angular | vec3 | [0,0,0] | Angular velocity |
| damping | number | 0 | |
| angularDamping | number | 0 | |
| gravity | number | 1 | Per-body gravity scale |
| freeze | object | — | `{ position: [bool,bool,bool], rotation: [bool,bool,bool] }` |
| sleep | boolean | true | Whether the body may be deactivated when at rest |
| impulse | vec3 | — | *Consumable.* Instantaneous impulse at the center of mass |
| torque | vec3 | — | *Consumable.* Instantaneous angular impulse |
| teleport | object | — | *Consumable.* `{ position, rotation }`, clears velocity |

**state**

| Field | Type | Meaning |
|---|---|---|
| velocity | vec3 | Simulated linear velocity |
| angular | vec3 | Simulated angular velocity |
| sleeping | boolean | |
| grounded | boolean | A contact exists with a surface whose normal is within 45° of up |

### 2.3.9 - collider

Collision geometry. An entity may contain several colliders, forming a compound shape. A collider
without a body in the same entity is static.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| shape | string | "auto" | "auto", "box", "sphere", "capsule", "cylinder", "plane", "convex", "mesh", "heightmap" |
| size | vec3 \| number | — | Required unless "auto"; "auto" derives from the sibling mesh's bounds |
| offset | vec3 | [0,0,0] | Local offset from the entity origin |
| rotation | vec3 \| vec4 | [0,0,0] | Local rotation |
| trigger | boolean | false | Generates contacts but no collision response |
| layer | string | "default" | The layer this collider occupies |
| mask | string[] | — | Layers this collider interacts with; omit for all |
| friction | number | 0.5 | |
| restitution | number | 0 | |

"convex", "mesh" and "heightmap" derive from the sibling mesh geometry. "mesh" and "heightmap" are
valid only on static bodies. A sibling mesh with `shape: "heightmap"` resolves "auto" to "heightmap".

**state**

| Field | Type | Meaning |
|---|---|---|
| contacts | object[] | `{ target, phase, point, normal, impulse }` |

`target` is the element path of the other entity. `phase` is "begin", "stay", or "end". The contacts
list is rewritten each simulation step; a "begin" is guaranteed to be visible to scripts for exactly
one frame, and an "end" likewise.

### 2.3.10 - joint

A constraint between the containing entity's body and another. Requires "physics".

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| type | string | "fixed" | "fixed", "hinge", "slider", "ball", "distance", "spring" |
| target | reference | — | The other entity; omit to constrain to the world |
| anchor | vec3 | [0,0,0] | Attachment point, local to this entity |
| targetAnchor | vec3 | [0,0,0] | Attachment point, local to the target |
| axis | vec3 | [0,1,0] | Hinge or slider axis |
| limits | vec2 | — | Min and max, in radians or meters per type |
| motor | object | — | `{ target, force }` — target velocity or position and maximum force |
| stiffness | number | — | Spring only |
| damping | number | — | Spring only |
| break | number | — | Force at which the joint destroys itself |

**state**

| Field | Type | Meaning |
|---|---|---|
| force | number | Current constraint force magnitude |
| broken | boolean | |

### 2.3.11 - audio

Sound, from `source` or `content`.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| spatial | boolean | false | Position from the containing entity |
| volume | number | 1 | |
| rate | number | 1 | Playback rate |
| loop | boolean | false | |
| autoplay | boolean | false | Play once loaded, subject to gesture policy |
| distance | vec2 | [1,100] | Reference and maximum distance for spatial falloff |
| cone | vec3 | — | `{ inner, outer, gain }` for directional sources |
| play | boolean \| number | — | *Consumable.* Begin playback, optionally at the given offset |
| stop | boolean | — | *Consumable.* |
| seek | number | — | *Consumable.* |

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | |
| playing | boolean | |
| time | number | Current playback position |
| duration | number | |
| blocked | boolean | Playback is awaiting a user gesture, or no audio engine exists yet |
| source | string | Which candidate location was actually loaded |
| error | string | Why nothing is playing, when nothing is playing |

### 2.3.12 - animation

Playback of named clips supplied by a mesh in the same entity, or by `source`.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| clip | string | — | Clip name; see the sibling mesh's `state.clips` |
| speed | number | 1 | |
| loop | boolean | true | |
| weight | number | 1 | Blend weight when several animation components are active |
| range | vec2 | — | Sub-range of the clip, in seconds |
| play | boolean | — | *Consumable.* |
| stop | boolean | — | *Consumable.* |
| seek | number | — | *Consumable.* |

**state**

| Field | Type | Meaning |
|---|---|---|
| playing | boolean | |
| time | number | |
| duration | number | |
| finished | boolean | True for one frame when a non-looping clip completes |

### 2.3.13 - script

Code, from `content` or `source`. See §2.4.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| language | string | "js" | |
| mode | string | "blunt" | "blunt" or "agnostic" |
| output | string | "patch" | "patch" or "override" |
| phase | string | "update" | "start", "update", or "step" (fixed timestep) |
| order | number | 0 | Execution priority; lower runs first |
| enabled | boolean | true | |

**state**

| Field | Type | Meaning |
|---|---|---|
| error | string | Message from the most recent failure |
| runs | integer | Number of successful executions |
| duration | number | Seconds consumed by the most recent execution |

### 2.3.14 - query

A question the document asks of the engine. Scripts create or patch the data; the engine writes the
answer to state on the same frame. If `continuous` is absent or false, the engine deletes the
component after writing the result.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| type | string | "ray" | "ray", "shape", "overlap", "pick", "hit-test" |
| origin | vec3 | — | World-space origin; defaults to the containing entity's position |
| offset | vec3 | [0,0,0] | Added to the origin, so a probe can track its entity without the document rewriting the origin each frame |
| direction | vec3 | [0,0,-1] | |
| distance | number | 1000 | |
| screen | vec2 | — | For "pick", normalized viewport coordinates instead of origin/direction |
| shape | object | — | For "shape" and "overlap": `{ shape, size }` as per collider |
| layer | string[] | — | Layers to test against; omit for all |
| limit | integer | 1 | Maximum hits to return; 0 for unlimited |
| continuous | boolean | false | Re-evaluate every frame rather than once |

**state**

| Field | Type | Meaning |
|---|---|---|
| hits | object[] | `{ target, point, normal, distance }`, nearest first |

`type: "hit-test"` requires an XR session with the "hit-test" feature and ignores origin and
direction, using the session's tracked input ray or viewer pose.

### 2.3.15 - time

Engine-created. See §2.5.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| scale | number | 1 | Multiplier applied to delta; 0 pauses simulation |

**state**

| Field | Type | Meaning |
|---|---|---|
| delta | number | Seconds since the previous frame, after scale |
| unscaled | number | Seconds since the previous frame, before scale |
| elapsed | number | Seconds since the document began running, after scale |
| frame | integer | Frames elapsed |
| step | number | The fixed timestep in effect |
| now | number | Wall-clock time, milliseconds since the Unix epoch |

### 2.3.16 - display

Engine-created. One per document.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| resolution | number | 1 | Render scale relative to native |
| cursor | string | "default" | "default", "hidden", "locked" |
| fullscreen | boolean | — | *Consumable.* Request or exit fullscreen |
| capture | boolean | — | *Consumable.* Request a frame capture, delivered to state.capture |

**state**

| Field | Type | Meaning |
|---|---|---|
| size | vec2 | Drawing buffer dimensions in pixels |
| ratio | number | Device pixel ratio |
| aspect | number | |
| focused | boolean | |
| fullscreen | boolean | |
| gesture | boolean | A user gesture has occurred, unblocking audio and XR |
| locked | boolean | The pointer is captured |
| xr | object | `{ presenting, mode, features, space }` |
| fps | number | Frames per second, averaged over the last second |
| capture | string | Data URL of the most recent requested capture |

### 2.3.17 - controller

Engine-created, one per connected input device. Created on connection and destroyed on
disconnection. Every input device in ACE — keyboard, pointer, touch point, gamepad, XR controller,
XR hand — is a controller, and is read identically.

**data**

| Field | Type | Meaning |
|---|---|---|
| haptic | object | *Consumable.* `{ intensity, duration }` |
| deadzone | number | Analog magnitude below which values are reported as zero; default 0.1 |

**state**

| Field | Type | Meaning |
|---|---|---|
| device | string | "keyboard", "pointer", "touch", "gamepad", "xr-controller", "xr-hand" |
| index | integer | Distinguishes multiple devices of the same kind |
| handedness | string | "left", "right", or "none" |
| digital | string[] | Every input currently on |
| pressed | string[] | Inputs that turned on this frame |
| released | string[] | Inputs that turned off this frame |
| analog | object | Input identifier to number |
| pose | object | `{ position, rotation, linear, angular }` for tracked devices |
| ray | object | `{ origin, direction }` — the device's targeting ray, tracked devices only |
| joints | object[] | `{ name, position, rotation, radius }`, XR hands only |

**Digital identifiers.**

- keyboard: `KeyboardEvent.code` values, e.g. "KeyW", "Space", "ArrowLeft", "ShiftLeft".
- pointer: "button0" through "button4".
- touch: "contact".
- gamepad: "a", "b", "x", "y", "left-bumper", "right-bumper", "left-stick", "right-stick",
  "start", "select", "up", "down", "left", "right", "home".
- xr-controller: "trigger", "squeeze", "thumbstick", "touchpad", "a", "b".
- xr-hand: "pinch", "grip".

**Analog identifiers.**

- pointer and touch: "x", "y" (normalized viewport position), "dx", "dy" (delta this frame),
  "wheel", "pressure".
- gamepad: "left-x", "left-y", "right-x", "right-y", "left-trigger", "right-trigger".
- xr-controller: "thumbstick-x", "thumbstick-y", "touchpad-x", "touchpad-y", "trigger", "squeeze".
- xr-hand: "pinch".

Analog values are in [-1,1] for axes and [0,1] for triggers and pressure. Adapters shall report
unknown inputs under their platform-native identifier rather than omitting them.

---

## 2.4 - Scripts

### 2.4.1 - Blunt Scripts

A script with `mode: "blunt"` uses the blunt input and blunt output forms of OQL agnostic scripts.
The script's code is the body of a function of two named parameters:

| Parameter | Contents |
|---|---|
| state | JSON serialization of the complete document |
| path | JSON serialization of the script component's element path, as a list of strings |

The function returns a string, or nothing. Returning nothing, an empty string, null, or undefined
is equivalent to returning no change.

Adapters shall construct the function with these parameter names bound, so that script authors
address them directly rather than through positional argument access.

### 2.4.2 - Output Modes

`output: "override"` — the returned string is parsed as JSON and replaces the document wholesale.

`output: "patch"` — the returned string is parsed as JSON and applied to the document root as a
JSON Merge Patch (RFC 7386). Objects merge recursively; a null value deletes the field it keys;
arrays and primitives replace wholesale.

Patches are rooted at the document, not at the script's entity; the script's own path is supplied
so that it may construct a patch addressing itself.

Merge Patch cannot append to or remove from an array. Where that is required, the script must
rewrite the array in full.

### 2.4.3 - Execution

Scripts of the requested phase execute once per frame, in ascending `order`, then in document
order among equal orders. Each script's output is applied before the next script executes, so a
script observes the results of those preceding it in the same frame.

After all scripts have executed, and before reconciliation, the engine:

1. Discards any content written to a `state` object or to the reserved entity (§2.5).
2. Applies and then clears all consumable fields (§2.2.4).
3. Rewrites every `state` object and the reserved entity from the current runtime.

This ordering makes `override` safe: a script may replace the entire authored document without
destroying input, timing, or reflected state.

A script which throws shall have its error recorded in `state.error` and shall not modify the
document that frame. A thrown error shall not halt the frame or other scripts.

### 2.4.4 - Agnostic Scripts

`mode: "agnostic"` is reserved for the non-blunt form of OQL agnostic scripts, in which the
function returns an OQL script that executes against the document as a DMDB, and receives the
result as a dynamic list on its next execution. It is not yet specified here.

---

## 2.5 - The Reserved Entity

The root package shall contain an entity aliased `engine`, created and maintained by the engine.
Documents shall not define it; any authored content at that path is discarded on load.

It contains the `time` and `display` components, and one `controller` component per connected
device, aliased by device kind and index, e.g. `engine.controllers.gamepad-0`.

Only the `state` of these components is rewritten. Their `data` — the time scale, the cursor mode —
is authored, belongs to the document, and shall be carried across the rewrite, so that a script may
set it and have it persist.

In an XR session with the "planes" or "meshes" features, the engine additionally creates entities
under `engine.detected`, each carrying a `mesh` component with manual geometry describing the
detected surface, and entity tags identifying its semantic label where the runtime supplies one.
Detected geometry is thereby readable, queryable, and renderable by the same mechanisms as authored
geometry, and requires no component of its own.

---

## 2.6 - Example

A cube that falls onto a floor, is lit, and can be pushed with the spacebar.

    {
      "packages": {
        "world": {
          "properties": { "meta": { "data": { } } },
          "utilities": {
            "settings": {
              "properties": {
                "tags": ["world", "telos-ace"],
                "data": {
                  "gravity": [0, -9.81, 0],
                  "background": "#101018",
                  "requires": ["physics"]
                }
              }
            }
          }
        },
        "camera": {
          "properties": {
            "meta": { "data": { "position": [0, 3, 8] } }
          },
          "utilities": {
            "view": {
              "properties": {
                "tags": ["camera", "telos-ace"],
                "data": { "target": [0, 0, 0], "control": "orbit" }
              }
            }
          }
        },
        "sun": {
          "properties": {
            "meta": { "data": { "rotation": [-0.9, 0.5, 0] } }
          },
          "utilities": {
            "light": {
              "properties": {
                "tags": ["light", "telos-ace"],
                "data": { "type": "directional", "intensity": 2, "shadow": true }
              }
            }
          }
        },
        "floor": {
          "properties": {
            "meta": { "data": { "position": [0, -1, 0] } }
          },
          "utilities": {
            "mesh": {
              "properties": {
                "tags": ["mesh", "telos-ace"],
                "data": { "shape": "box", "size": [20, 0.5, 20] }
              }
            },
            "collider": {
              "properties": {
                "tags": ["collider", "telos-ace"],
                "data": { "shape": "auto" }
              }
            }
          }
        },
        "crate": {
          "properties": {
            "meta": { "data": { "position": [0, 5, 0] } }
          },
          "utilities": {
            "mesh": {
              "properties": {
                "tags": ["mesh", "telos-ace"],
                "data": { "shape": "box", "size": 1 }
              }
            },
            "surface": {
              "properties": {
                "tags": ["material", "telos-ace"],
                "data": { "color": "#c08040", "roughness": 0.8 }
              }
            },
            "collider": {
              "properties": {
                "tags": ["collider", "telos-ace"],
                "data": { "shape": "auto" }
              }
            },
            "body": {
              "properties": {
                "tags": ["body", "telos-ace"],
                "data": { "mode": "dynamic", "mass": 2 }
              }
            },
            "push": {
              "content": "const s = JSON.parse(state); const k = s.packages.engine.packages.controllers.utilities['keyboard-0']; if (!k || !k.properties.state.pressed.includes('Space')) return; return JSON.stringify({ packages: { crate: { utilities: { body: { properties: { data: { impulse: [0, 6, 0] } } } } } } });",
              "properties": {
                "tags": ["script", "telos-ace"],
                "data": { "language": "js", "mode": "blunt", "output": "patch" }
              }
            }
          }
        }
      }
    }
