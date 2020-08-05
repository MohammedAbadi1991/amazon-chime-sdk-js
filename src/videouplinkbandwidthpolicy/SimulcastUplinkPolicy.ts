// Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Logger from '../logger/Logger';
import SimulcastTransceiverController from '../transceivercontroller/SimulcastTransceiverController';
import DefaultVideoAndEncodeParameter from '../videocaptureandencodeparameter/DefaultVideoCaptureAndEncodeParameter';
import VideoStreamDescription from '../videostreamindex/VideoStreamDescription';
import VideoStreamIndex from '../videostreamindex/VideoStreamIndex';
import BitrateParameters from './BitrateParameters';
import VideoUplinkBandwidthPolicy from './VideoUplinkBandwidthPolicy';

/**
 * [[SimulcastUplinkPolicy]] determines capture and encode
 *  parameters that reacts to estimated uplink bandwidth
 */
export default class SimulcastUplinkPolicy implements VideoUplinkBandwidthPolicy {
  static readonly defaultUplinkBandwidthKbps: number = 1100;
  static readonly startupDurationMs: number = 6000;
  static readonly holdDownDurationMs: number = 4000;
  static readonly defaultMaxFrameRate = 15;

  private numParticipants: number = 0;
  private optimalParameters: DefaultVideoAndEncodeParameter;
  private parametersInEffect: DefaultVideoAndEncodeParameter;

  private newQualityMap = new Map<string, RTCRtpEncodingParameters>();
  private currentQualityMap = new Map<string, RTCRtpEncodingParameters>();
  private lastUplinkBandwidthKbps: number = 1100;

  private newMediaTrackConstraints: MediaTrackConstraints = {};
  private currMediaTrackConstraints: MediaTrackConstraints = {};
  private startTimeMs: number = 0;
  private lastUpdatedMs: number = Date.now();

  private videoIndex: VideoStreamIndex | null = null;

  private currLocalDescriptions: VideoStreamDescription[] = [];
  private nextLocalDescriptions: VideoStreamDescription[] = [];

  constructor(private selfAttendeeId: string, private logger: Logger) {
    this.optimalParameters = new DefaultVideoAndEncodeParameter(0, 0, 0, 0, true);
    this.parametersInEffect = new DefaultVideoAndEncodeParameter(0, 0, 0, 0, true);

    this.lastUplinkBandwidthKbps =  SimulcastUplinkPolicy.defaultUplinkBandwidthKbps;

    this.currentQualityMap = this.fillEncodingParamWithBitrates([300, 500, 1100]);
    this.newQualityMap = this.fillEncodingParamWithBitrates([300, 500, 1100]);

    this.newMediaTrackConstraints = this.fillMediaTrackConstraints();
    this.currMediaTrackConstraints = this.fillMediaTrackConstraints();
  }

  updateConnectionMetric({
    uplinkKbps = 0,
  }: {
    uplinkKbps?: number;
  } = {}): void {
    if (isNaN(uplinkKbps)) {
      return;
    }

    // Check if startup period in order to ignore estimate when video first enabled.
    // If only audio was active then the estimate will ve very low
    if (this.startTimeMs === 0) {
      this.startTimeMs = Date.now();
    }
    if ((Date.now() - this.startTimeMs) < SimulcastUplinkPolicy.startupDurationMs) {
      this.lastUplinkBandwidthKbps = SimulcastUplinkPolicy.defaultUplinkBandwidthKbps;
    }
    else {
      this.lastUplinkBandwidthKbps = uplinkKbps;
    }
    this.logger.debug(() => {
      return `simulcast: uplink policy update metrics ${this.lastUplinkBandwidthKbps}`;
    });
    if (Date.now() < this.lastUpdatedMs + SimulcastUplinkPolicy.holdDownDurationMs) {
      return;
    }

    this.newQualityMap = this.calculateEncodingParameters();
    this.newMediaTrackConstraints = this.fillMediaTrackConstraints();
  }

  private calculateEncodingParameters(): Map<string, RTCRtpEncodingParameters> {
    // bitrates parameter min is not used for now
    let newBitrates: BitrateParameters[] = [
      new BitrateParameters(),
      new BitrateParameters(),
      new BitrateParameters(),
    ];

    if (this.numParticipants <= 2 && this.lastUplinkBandwidthKbps >= 1200) {
      // 320x192+ (640x384) +  + 1280x768
      newBitrates[0].maxBitrateKbps = 300;

      newBitrates[1].maxBitrateKbps = 0;

      newBitrates[2].maxBitrateKbps = 1200;
    } else if (this.numParticipants <= 2 && this.lastUplinkBandwidthKbps >= 1000) {
      // 240x144 + (480x288) + 960x576
      newBitrates[0].maxBitrateKbps = 200;

      newBitrates[1].maxBitrateKbps = 0;

      newBitrates[2].maxBitrateKbps = 1000;
    } else if (this.numParticipants <= 4 && this.lastUplinkBandwidthKbps >= 600) {
      // 240x144 + (480x288) + 960x576
      newBitrates[0].maxBitrateKbps = 200;

      newBitrates[1].maxBitrateKbps = 0;

      newBitrates[2].maxBitrateKbps = 800;
    } else if (this.lastUplinkBandwidthKbps >= 250) {
      // 320x192 + 640x384 + (1280x768)
      newBitrates[0].maxBitrateKbps = 200;

      newBitrates[1].maxBitrateKbps = 400;

      newBitrates[2].maxBitrateKbps = 0;
        
      } else {
        // 320x192 + 640x384 + (1280x768)
        newBitrates[0].maxBitrateKbps = 300;

        newBitrates[1].maxBitrateKbps = 0;
  
      newBitrates[2].maxBitrateKbps = 0;
    }
    const bitrates: number[] = newBitrates.map((v, _i, _a) => {
      return v.maxBitrateKbps;
    });

    this.newQualityMap = this.fillEncodingParamWithBitrates(bitrates);
    if (!this.encodingParametersEqual()) {
      this.logger.info('simulcast: policy:calculateEncodingParameters created newQualityMap:' + this.getQualityMapString(this.newQualityMap));
    }
    return this.newQualityMap;
  }

  chooseMediaTrackConstraints(): MediaTrackConstraints {
    this.currMediaTrackConstraints = this.newMediaTrackConstraints;
    return this.currMediaTrackConstraints;
  }

  chooseEncodingParameters(): Map<string, RTCRtpEncodingParameters> {
    this.currentQualityMap = this.newQualityMap;
    return this.currentQualityMap;
  }

  updateIndex(videoIndex: VideoStreamIndex): void {
    // the +1 for self is assuming that we intend to send video, since
    // the context here is VideoUplinkBandwidthPolicy
    this.numParticipants =
      videoIndex.numberOfVideoPublishingParticipantsExcludingSelf(this.selfAttendeeId) + 1;
    this.optimalParameters = new DefaultVideoAndEncodeParameter(
      this.captureWidth(),
      this.captureHeight(),
      this.captureFrameRate(),
      this.maxBandwidthKbps(),
      false
    );
    this.videoIndex = videoIndex;
    this.newQualityMap = this.calculateEncodingParameters();
    this.newMediaTrackConstraints = this.fillMediaTrackConstraints();
  }

  wantsResubscribe(): boolean {
    let constraintDiff = !(
      JSON.stringify(this.currMediaTrackConstraints.width) ===
        JSON.stringify(this.newMediaTrackConstraints.width) &&
      JSON.stringify(this.currMediaTrackConstraints.height) ===
        JSON.stringify(this.newMediaTrackConstraints.height) &&
      JSON.stringify(this.currMediaTrackConstraints.frameRate) ===
        JSON.stringify(this.newMediaTrackConstraints.frameRate)
    );

    for (const ridName of SimulcastTransceiverController.NAME_ARR_ASCENDING) {
      constraintDiff =
        constraintDiff ||
        !this.compareEncodingParameter(
          this.newQualityMap.get(ridName),
          this.currentQualityMap.get(ridName)
        );
      if (constraintDiff) {
        break;
      }
    }

    this.nextLocalDescriptions = this.videoIndex.localStreamDescriptions();
    for (let i = 0; i < this.nextLocalDescriptions.length; i++) {
      const streamId = this.nextLocalDescriptions[i].streamId;
      if (streamId !== 0 && !!streamId) {
        const prevIndex = this.currLocalDescriptions.findIndex(val => {
          return val.streamId === streamId;
        });
        if (prevIndex !== -1) {
          if (
            this.nextLocalDescriptions[i].disabledByWebRTC !==
            this.currLocalDescriptions[prevIndex].disabledByWebRTC
          ) {
            constraintDiff = true;
          }
        }
      }
    }

    if (constraintDiff) {
      this.lastUpdatedMs = Date.now();
    }

    this.currLocalDescriptions = this.nextLocalDescriptions;
    return constraintDiff;
  }

  private compareEncodingParameter(
    encoding1: RTCRtpEncodingParameters,
    encoding2: RTCRtpEncodingParameters
  ): boolean {
    return JSON.stringify(encoding1) === JSON.stringify(encoding2);
  }

  private encodingParametersEqual() {
    let different = false;
    for (const ridName of SimulcastTransceiverController.NAME_ARR_ASCENDING) {
      different =
        different ||
        !this.compareEncodingParameter(
          this.newQualityMap.get(ridName),
          this.currentQualityMap.get(ridName)
        );
    }

    return different;
  }

  chooseCaptureAndEncodeParameters(): DefaultVideoAndEncodeParameter {
    // should deprecate in this policy
    this.parametersInEffect = this.optimalParameters.clone();
    return this.parametersInEffect.clone();
  }

  private captureWidth(): number {
    // should deprecate in this policy
    const width = 1280;
    return width;
  }

  private captureHeight(): number {
    // should deprecate in this policy
    let height = 768;
    return height;
  }

  private captureFrameRate(): number {
    // should deprecate in this policy
    return 15;
  }

  maxBandwidthKbps(): number {
    // should deprecate in this policy
    return 1400;
  }

  setIdealMaxBandwidthKbps(_idealMaxBandwidthKbps: number): void {
    // should deprecate in this policy
  }

  setHasBandwidthPriority(_hasBandwidthPriority: boolean): void {
    // should deprecate in this policy
  }

  private fillEncodingParamWithBitrates(
    bitratesKbps: number[]
  ): Map<string, RTCRtpEncodingParameters> {
    const newMap = new Map<string, RTCRtpEncodingParameters>();
    const toBps = 1000;
    const nameArr = SimulcastTransceiverController.NAME_ARR_ASCENDING;
    const bitrateArr = bitratesKbps;

    let scale = 4;
    for (let i = 0; i < nameArr.length; i++) {
      const ridName = nameArr[i];
      newMap.set(ridName, {
        rid: ridName,
        active: bitrateArr[i] > 0 ? true : false,
        scaleResolutionDownBy: scale,
        maxBitrate: bitrateArr[i] * toBps,
      });
      scale = scale / 2;
    }

    return newMap;
  }

  private fillMediaTrackConstraints(): MediaTrackConstraints {
    let trackConstraint: MediaTrackConstraints;
    if (this.numParticipants <= 2 && this.lastUplinkBandwidthKbps >= 1100) {
      trackConstraint = {
        width: { ideal: 1280 },
        height: { ideal: 768 },
        frameRate: { ideal: 15 },
      };
    } else if (this.numParticipants <= 4 && this.lastUplinkBandwidthKbps >= 600) {
      trackConstraint = {
        width: { ideal: 960 },
        height: { ideal: 576 },
        frameRate: { ideal: 15 },
      };
    } else {
      trackConstraint = {
        width: { ideal: 1280 },
        height: { ideal: 768 },
        frameRate: { ideal: 15 },
      };
    }

    return trackConstraint;
  }

  private getQualityMapString(params: Map<string, RTCRtpEncodingParameters>): string {
    let qualityString = '';
    const localDescriptions = this.videoIndex.localStreamDescriptions();
    params.forEach((value: RTCRtpEncodingParameters, key:string) => {
      let disabledByWebRTC = false;
      if (localDescriptions.length === 3) {
        if (value.rid === 'low') disabledByWebRTC = localDescriptions[0].disabledByWebRTC;
        else if (value.rid === 'mid')  disabledByWebRTC = localDescriptions[1].disabledByWebRTC;
        else  disabledByWebRTC = localDescriptions[2].disabledByWebRTC;
      }
      qualityString += '{ rid:' + value.rid + ' active:' + value.active + ' disabledByWebRTC:' +  disabledByWebRTC + ' maxBitrate:' + value.maxBitrate + ' } ';
    });
    return qualityString;
  }

}
