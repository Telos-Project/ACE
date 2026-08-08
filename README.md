# ACE

## 1 - Abstract

***Write Once, Render Anywhere***

ACE, or Telos ACE, is an [APInt](https://github.com/Telos-Project/APInt) based game engine content
format, with associated adapters for certain game engines.

## 2 - Contents

### 2.1 - G-Scene

G-Scene is an APInt mask which allows "entities" to be used in place of "packages", and
"components" to be used in place of "utilities".

It is intended to be used for entity-component systems, and is supported by ACE.

### 2.2 - Components

All ACE component utilities shall have the tag "telos-ace", and their primary tag type shall
determine the type of component they represent.

Any information, or "data point", for a component not specified in its content shall be specified
using sub-fields of a "data" object embedded as a property of the component utility.

#### 2.2.1 - Scripts

ACE Scripts may be written, in principle, in any language. The content of the component utility
shall specify the code of the script, and a "language" data point specifying the language used as a
string.

The code shall be written as an [OQL Agnostic Script](https://github.com/Telos-Project/OmniQuery?tab=readme-ov-file#21136---agnostic-scripts).

#### 2.2.2 - Component Protocols

A codified standard for a set of ACE components to be supported by ACE adapters is referred to as
an ACE component protocol.

### 2.3 - Application

#### 2.3.1 - Dynamic Declarative Simuation Pipeline

The Dynamic Declarative Simuation Pipeline (DDSP) is a process where a declarative document, called
the simulation reference, details the entities present in a simulation, and on each cycle of the
simulation engine, an AI updates the content of the simulation reference to advance the state, a
process which may base itself on codified conventions called simulation update conventions, and
then renders views of the content of the simulation based on codified conventions called simulation
rendering conventions.

Simulation update and rendering conventions may themselves be encoded within simulation references.

Additionally, DDSP may be used to graft world models via scaffolding onto AI processes that are
powered by otherwise stateless AI models.

##### 2.3.1.1 - ACE Simulation Documents

ACE may be used for simulation documents.

#### 2.3.2 - Seamless Content

A seamless content consists of a game content built within another game rather than a game engine,
in such a way that it may be portable between games.

##### 2.3.2.1 - Seamless State

Seamless state consists of seamless content transitioning between host applications and contexts
while maintaining a persisting state.

The information relevant to seamless state may be represented externally to host applications, and
may do this using
[general ontologies](https://github.com/Telos-Project/Bus-Net?tab=readme-ov-file#22---general-ontologies).

##### 2.3.2.2 - Seamless ACE Content

ACE may be used for seamless content.

#### 2.3.3 - Agentic NPCs

Agentic NPCs are bots, and contexts for said bots, engaging with a game through the same interface
human players use.

Depending on their configuration, they may be programmed to act as though they are another player,
or to stay in character for a specific role.