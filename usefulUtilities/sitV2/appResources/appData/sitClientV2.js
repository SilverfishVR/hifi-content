//
// sitClient.js
//
// Created by Robin Wilson 5/7/2019
// 
// Original sit script created by Clement Brisset on 3/3/17
// Previous script modified by Robin Wilson, Rebecca Stankus, and Alexia Mandeville June 2018
//
// Copyright 2019 High Fidelity, Inc.
//
// Distributed under the Apache License, Version 2.0.
// See the accompanying file LICENSE or http://www.apache.org/licenses/LICENSE-2.0.html
//
// Allows avatars to sit in High Fidelity after clicking on a local entity or on the chair. Works with sitServer.js.
//

/* global DriveKeys, isInEditMode */

(function () {
    
    var DEBUG = 0;

    // #region UTILITIES

    Script.include("/~/system/libraries/utils.js");


    // Returns entity properties for an overlay in front of user's camera in desktop and VR
    function getEntityPropertiesForImageInFrontOfCamera(positionInFront, dimensions, url) {
        return {
            type: "Image",
            grab: { grabbable: false },
            dynamic: false,
            parentJointIndex: MyAvatar.getJointIndex("_CAMERA_MATRIX"),
            imageURL: url,
            position: Vec3.sum(Camera.position, Vec3.multiplyQbyV(Camera.orientation, positionInFront)),
            dimensions: dimensions,
            rotation: Camera.rotation,
            parentID: MyAvatar.sessionUUID,
            ignoreRayIntersection: false,
            visible: true,
            emissive: true,
            renderLayer: "front"
        };
    }


    // String utility
    function startsWith(str, searchString, position) {
        position = position || 0;
        return str.substr(position, searchString.length) === searchString;
    }


    // Return the animation roles to override
    function rolesToOverride() {
        // Get all animation roles that sit will override
        return MyAvatar.getAnimationRoles().filter(function (role) {
            return !(startsWith(role, "right") || startsWith(role, "left"));
        });
    }


    // Checks for Avatar Spine Error in VR to avoid uncomfortable looking avatar position
    var NEG_ONE = -1;
    var HALF = 0.5;
    function setHeadToHipsDistance() {
        // get hips world pos while sitting
        if (MyAvatar.getJointIndex("Head") === NEG_ONE) {
            // this can probably be adjusted to be more accurate
            _this.headToHipsDistance = MyAvatar.getHeight() * HALF;
        } else {
            var headTranslation = MyAvatar.getAbsoluteDefaultJointTranslationInObjectFrame(MyAvatar.getJointIndex("Head"));
            var hipsTranslation = MyAvatar.getAbsoluteDefaultJointTranslationInObjectFrame(MyAvatar.getJointIndex("Hips"));
            _this.headToHipsDistance = Math.abs(headTranslation.y - hipsTranslation.y);
        }
    }


    // Calculates where the avatar's hips will seat 
    // Used to calculate pin hip position. Adds CHAIR_OFFSET_RATIO * chair's y dimension to the y center of the seat.
    // Avatar sit position y = CHAIR_OFFSET_RATIO * height of chair
    var CHAIR_OFFSET_RATIO = 0.1;
    function calculateSeatCenterPositionForPinningAvatarHips() {
        var properties = Entities.getEntityProperties(_this.entityID);

        var yOffset = properties.dimensions.y * CHAIR_OFFSET_RATIO;
        _this.seatCenterPosition = properties.position;
        _this.seatCenterPosition.y = properties.position.y + yOffset;
    }

    // #endregion UTILITIES


    // #region SIT DOWN / STAND UP SEQUENCE

    // 1st of sit down sequence
    // Send request to server script to begin sit down
    // Will lock chair from other avatars sitting in it
    function sendRequestToServerScriptToStartSitDown() {
        Entities.callEntityServerMethod(
            _this.entityID,
            "onSitDown",
            [MyAvatar.sessionUUID]
        );
    }


    // 2nd of sit down sequence
    // Called from entity server script to begin sitting down sequence
    var SETTING_KEY_AVATAR_SITTING = "com.highfidelity.avatar.isSitting";
    var SIT_SETTLE_TIME_MS = 350; // Do not pop avatar out of chair immediately if there's an issue
    var STANDUP_DELAY_MS = 25; // ms for timeout in standup
    var SIT_DELAY_MS = 50; // ms for timeouts in sit
    var CAN_SIT_M = 5; // zone radius
    function startSitDown() {
        if (DEBUG) {
            console.log("startSitDown");
        }

        Entities.callEntityServerMethod(
            _this.entityID,
            "removeAllOtherSittableOverlays",
            AvatarList.getAvatarsInRange(_this.seatCenterPosition, CAN_SIT_M)
        );

        deleteSittableUI();

        // Set isSitting value in Settings
        var sitPreviousSettings = Settings.getValue(SETTING_KEY_AVATAR_SITTING);
        var sitNewSettings = [_this.entityID, MyAvatar.position, MyAvatar.orientation]; // ***
        if (sitPreviousSettings && sitPreviousSettings.length === sitNewSettings.length) {
            // changed chair, only change entityID, keep old values for previousAvatarPosition and previousAvatarOrientation
            sitNewSettings[1] = sitPreviousSettings[1];
            sitNewSettings[2] = sitPreviousSettings[2];
        }
        Settings.setValue(SETTING_KEY_AVATAR_SITTING, sitNewSettings);

        if (HMD.active) {
            createPresit();
            Script.setTimeout(function () {
                beforeSitDown();
            }, PRESIT_FRAME_DURATION * _this.preSitLoadedImages.length);
        } else {
            beforeSitDown();
        }
    }


    // 3rd of sit down sequence (callback for inside 2nd)
    // Used before pinning hips, calculate the math required and lock the chair
    function beforeSitDown() {
        // Set the value of head to hips distance
        // If avatar deviates outside of the minimum and maximum, the avatar will pop out of the chair
        setHeadToHipsDistance();

        // Lock chair and save old setting
        _this.locked = Entities.getEntityProperties(_this.entityID, 'locked').locked;
        Entities.editEntity(_this.entityID, { locked: true });

        calculateSeatCenterPositionForPinningAvatarHips();

        sitDownAndPinAvatar();
    }


    // 4th of sit down sequence
    // Sit the avatar down (in the sitting animation) and pin the hips to the spot
    var ANIMATION_URL = Script.resolvePath("./resources/animations/sittingIdle.fbx");
    var ANIMATION_FPS = 30;
    var ANIMATION_FIRST_FRAME = 1;
    var ANIMATION_LAST_FRAME = 350;
    var UPDATE_INTERVAL_MS = 400;
    var OVERRIDDEN_DRIVE_KEYS = [
        DriveKeys.TRANSLATE_X,
        DriveKeys.TRANSLATE_Y,
        DriveKeys.TRANSLATE_Z,
        DriveKeys.STEP_TRANSLATE_X,
        DriveKeys.STEP_TRANSLATE_Y,
        DriveKeys.STEP_TRANSLATE_Z
    ];
    function sitDownAndPinAvatar() {
        MyAvatar.collisionsEnabled = false;
        MyAvatar.hmdLeanRecenterEnabled = false;

        if (HMD.active) {
            deletePresit();
        }

        var roles = rolesToOverride();
        for (var i in roles) { // restore roles to prevent overlap
            MyAvatar.restoreRoleAnimation(roles[i]);
            MyAvatar.overrideRoleAnimation(roles[i], ANIMATION_URL, ANIMATION_FPS, true,
                ANIMATION_FIRST_FRAME, ANIMATION_LAST_FRAME);
        }
        for (var j in OVERRIDDEN_DRIVE_KEYS) {
            MyAvatar.disableDriveKey(OVERRIDDEN_DRIVE_KEYS[j]);
        }

        MyAvatar.centerBody();

        Script.setTimeout(function () {
            var hipIndex = MyAvatar.getJointIndex("Hips");
            var properties = Entities.getEntityProperties(_this.entityID);
            _this.sitDownSettlePeriod = Date.now() + SIT_SETTLE_TIME_MS;
            MyAvatar.goToLocation(_this.seatCenterPosition, true, Quat.fromVec3Degrees(properties.rotation), false, false);
            MyAvatar.pinJoint(hipIndex, _this.seatCenterPosition, properties.rotation);
            stopUpdateInterval();

            _this.whileSittingUpdateIntervalID = Script.setInterval(_this.whileSittingUpdate, UPDATE_INTERVAL_MS);

            deleteSittableUI();

            if (!_this.connectedSignals) {
                MyAvatar.scaleChanged.connect(_this.standUp);
                MyAvatar.onLoadComplete.connect(_this.standUp);
                location.hostChanged.connect(_this.standUp);
                Script.scriptEnding.connect(_this.standUp);
                MyAvatar.skeletonModelURLChanged.connect(_this.standUp);
                MyAvatar.wentAway.connect(_this.standUp);
                _this.connectedSignals = true;
            }
        }, SIT_DELAY_MS);
    }

    // 5th of sit down sequence
    // Handles stand up conditions
    // Update interval while the avatar is sitting
    // Listens for drive keys held, spine error (in VR), and if avatar teleported away from chair
    var AVATAR_MOVED_TOO_FAR_DISTANCE_M = 0.5;
    var MAX_HEAD_DEVIATION_RATIO = 1.2;
    var MIN_HEAD_DEVIATION_RATIO = 0.8;
    var DRIVE_KEY_RELEASE_TIME_MS = 800; // ms
    var HEAD_DEVIATION_MAX_TIME_TO_STAND_MS = 1000;
    function whileSittingUpdate() {
        var now = Date.now();

        // ACTIVE DRIVE KEY
        // Check if a drive key is pressed
        var hasActiveDriveKey = false;
        for (var i in OVERRIDDEN_DRIVE_KEYS) {
            if (MyAvatar.getRawDriveKey(OVERRIDDEN_DRIVE_KEYS[i]) !== 0.0) {
                hasActiveDriveKey = true;
                if (!_this.driveKeyPressedStart) {
                    _this.driveKeyPressedStart = now;
                }
                if (!_this.standUpID) {
                    createStandUp();
                    if (DEBUG) {
                        console.log("active drive key pressed once");
                    }
                }
                break;
            }
        }

        // Only standup if user has been pushing a drive key for DRIVE_KEY_RELEASE_TIME_MS
        if (hasActiveDriveKey) {
            if (_this.driveKeyPressedStart && (now - _this.driveKeyPressedStart) > DRIVE_KEY_RELEASE_TIME_MS) {
                _this.standUp();
                if (DEBUG) {
                    console.log("active drive key pressed caused standup");
                }

            }
        } else {
            if (_this.standUpID) {
                _this.driveKeyPressedStart = false;
                deleteStandUp();
            }
        }

        if (_this.sitDownSettlePeriod && now < _this.sitDownSettlePeriod) {
            // below considerations only apply if sit down settle period has passed
            return;
        } else {
            _this.sitDownSettlePeriod = false;
        }

        // AVATAR DISTANCE
        if (Vec3.distance(MyAvatar.position, _this.seatCenterPosition) > AVATAR_MOVED_TOO_FAR_DISTANCE_M) {
            _this.standUp();
            if (DEBUG) {
                console.log("avatar distance caused standup");
            }
            return;
        }

        // AVATAR SPINE ERROR
        if (HMD.active) {
            // If head is more than certain distance from hips or less than certain distance, stand up
            var headPoseValue = Controller.getPoseValue(Controller.Standard.Head);
            var headWorldPosition = Vec3.sum(
                Vec3.multiplyQbyV(MyAvatar.orientation, headPoseValue.translation),
                MyAvatar.position
            );
            var headDeviation = Vec3.distance(headWorldPosition, _this.seatCenterPosition);
            var headDeviationRatio = headDeviation / _this.headToHipsDistance;

            if (headDeviationRatio < MIN_HEAD_DEVIATION_RATIO || headDeviationRatio > MAX_HEAD_DEVIATION_RATIO) {
                if (!_this.deviationTimeStart) {
                    _this.deviationTimeStart = now;
                }
                if (now - _this.deviationTimeStart > HEAD_DEVIATION_MAX_TIME_TO_STAND_MS) {
                    _this.deviationTimeStart = false;
                    _this.standUp();
                    if (DEBUG) {
                        console.log("avatar spine error caused standup");
                    }
                }
            } else {
                _this.deviationTimeStart = false;
            }
        }
    }


    // Clear whileSitting update interval
    function stopUpdateInterval() {
        if (_this.whileSittingUpdateIntervalID) {
            Script.clearInterval(_this.whileSittingUpdateIntervalID);
            _this.whileSittingUpdateIntervalID = false;
        }
    }


    // Standup functionality
    var STANDUP_DISTANCE_M = 0.5; // m 
    var CHAIR_DISMOUNT_OFFSET_M = -0.5; // m in front of chair
    function standUp() {
        if (DEBUG) {
            console.log("standup");
        }

        // get the entityID, previous position and orientation 
        var sitCurrentSettings = Settings.getValue(SETTING_KEY_AVATAR_SITTING);
        var settingsEntityID = sitCurrentSettings[0];
        var settingsPreviousPosition = sitCurrentSettings[1];
        var settingsPreviousOrientation = sitCurrentSettings[2];

        MyAvatar.clearPinOnJoint(MyAvatar.getJointIndex("Hips"));

        // STANDING FROM THIS CHAIR
        // Make avatar stand up
        if (settingsEntityID === _this.entityID) {
            // standing up from this chair
            // Need to enable roles and drive keys and reposition avatar 

            // ENABLE DRIVE KEYS
            for (var i in OVERRIDDEN_DRIVE_KEYS) {
                MyAvatar.enableDriveKey(OVERRIDDEN_DRIVE_KEYS[i]);
            }

            // RESTORE ANIMATION ROLES
            var roles = rolesToOverride();
            for (var j in roles) {
                MyAvatar.restoreRoleAnimation(roles[j]);
            }

            // If changed seat do not do this
            MyAvatar.collisionsEnabled = true;
            MyAvatar.hmdLeanRecenterEnabled = true;
            Script.setTimeout(function () {
                MyAvatar.centerBody();
            }, STANDUP_DELAY_MS);

            // SET AVATAR POSITION AND ORIENTATION TO PREVIOUS VALUES
            var avatarDistance = Vec3.distance(MyAvatar.position, _this.seatCenterPosition);
            var properties = Entities.getEntityProperties(_this.entityID);
            if (avatarDistance < STANDUP_DISTANCE_M) { // might need to 
                // Avatar did not teleport far away from chair
                // Therefore apply previous position OR the default dismount position and orientation
                if (settingsPreviousPosition && settingsPreviousOrientation) {
                    // Apply previous position and orientation because they exist
                    MyAvatar.position = settingsPreviousPosition;
                    MyAvatar.orientation = settingsPreviousOrientation;
                } else {
                    // Calculate chair default dismount position in front of chair
                    var offset = {
                        x: 0,
                        y: 1.0,
                        z: CHAIR_DISMOUNT_OFFSET_M - properties.dimensions.z * properties.registrationPoint.z
                    };
                    var position = Vec3.sum(properties.position, Vec3.multiplyQbyV(properties.rotation, offset));
                    MyAvatar.position = position;
                }
            }
            Settings.setValue(SETTING_KEY_AVATAR_SITTING, "");
        }

        // RESET SETTINGS FOR THIS CHAIR
        // Could have changed seats, keep avatar sitting if did not go through above procedure
        if (!_this.locked) {
            Entities.editEntity(_this.entityID, { locked: false });
        }

        _this.driveKeyPressedStart = false;
        _this.sitDownSettlePeriod = false;
        deleteStandUp();

        Entities.callEntityServerMethod(_this.entityID, "onStandUp");

        stopUpdateInterval();

        if (_this.connectedSignals) {
            MyAvatar.scaleChanged.disconnect(_this.standUp);
            MyAvatar.onLoadComplete.disconnect(_this.standUp);
            location.hostChanged.disconnect(_this.standUp);
            Script.scriptEnding.disconnect(_this.standUp);
            MyAvatar.skeletonModelURLChanged.disconnect(_this.standUp);
            MyAvatar.wentAway.disconnect(_this.standUp);
            _this.connectedSignals = false;
        }

        // RESET OVERLAYS FOR ALL AVATARS IN RANGE OF THE CHAIR
        Entities.callEntityServerMethod(
            _this.entityID,
            "addAllOtherSittableOverlays",
            AvatarList.getAvatarsInRange(_this.seatCenterPosition, CAN_SIT_M)
        );
    }

    // Remotely called from canSitZone
    var AVATAR_SITTING_IN_CHAIR_RANGE = 0.01;
    function onEnterCanSitZone(id, params) {
        if (params && params.length > 0) {
            _this.zoneID = params[0];
        }

        if (!isInEditMode()) {
            calculateSeatCenterPositionForPinningAvatarHips();
            var isSittingInChair = AvatarList.isAvatarInRange(_this.seatCenterPosition, AVATAR_SITTING_IN_CHAIR_RANGE);
            if (DEBUG) {
                console.log("onEnterCanSitZone" + !_this.sittableUIID + !isSittingInChair);
            }
            if (!_this.sittableUIID && !isSittingInChair) {
                createSittableUI();
            }
        } else {
            if (DEBUG) {
                console.log("entered zone and isInEditMode");
            }
            // is in edit mode do not create sittable
        }
    }


    // Remotely called by the canSitZone
    function onLeaveCanSitZone() {
        deleteSittableUI();
    }

    // #endregion SIT DOWN / STAND UP SEQUENCE


    // #region PRESIT - LOCAL ENTITY shown in HMD before sitting and after clicking sittable overlay
    // Has the sitting animation and "Please Face Forward"

    // Prefetch all presit overlay images into user's client
    var PRESIT_FRAME_DURATION = 160; // ms time duration for HMD presit overlay
    var PRESIT_URL_ROOT = Script.resolvePath("./resources/images/presit/sitConfirm");
    var PRESIT_URL_POSTFIX = ".png";
    var PRESIT_URL_NUM = 12;
    var PRESIT_URL_TEXT = Script.resolvePath("./resources/images/presit/pleaseFaceForward.png");
    function prefetchPresitImages() {
        var str;
        for (var i = 0; i < PRESIT_URL_NUM; i++) {
            str = i + 1;
            _this.preSitLoadedImages[i] = TextureCache.prefetch(Script.resolvePath(PRESIT_URL_ROOT + str + PRESIT_URL_POSTFIX));
        }
        _this.preSitTextLoadedImage = TextureCache.prefetch(PRESIT_URL_TEXT);
    }

    // Create the VR presit animation local entity in front of user's screen
    var SIT_ANIMATION_POSITION_IN_FRONT = { x: 0, y: 0.1, z: -1 };
    var SIT_ANIMATION_DIMENSIONS = { x: 0.2, y: 0.2 };
    var PLEASE_FACE_FORWARD_POSITION_IN_FRONT = { x: 0, y: -0.05, z: -1 };
    var PLEASE_FACE_FORWARD_DIMENSIONS = { x: 0.425, y: 0.425 };
    function createPresit() {
        var currentPresitAnimationFrame = 0;
        _this.presitAnimationImageID = Entities.addEntity(
            getEntityPropertiesForImageInFrontOfCamera(
                SIT_ANIMATION_POSITION_IN_FRONT,
                SIT_ANIMATION_DIMENSIONS,
                _this.preSitLoadedImages[currentPresitAnimationFrame].url
            ),
            "local"
        );

        _this.presitTextID = Entities.addEntity(
            getEntityPropertiesForImageInFrontOfCamera(
                PLEASE_FACE_FORWARD_POSITION_IN_FRONT,
                PLEASE_FACE_FORWARD_DIMENSIONS,
                _this.preSitTextLoadedImage.url
            ),
            "local"
        );

        // Flash through the presit animation images via overlay for a smooth avatar sitting animation
        _this.presitIntervalID = Script.setInterval(function () {
            if (_this.presitAnimationImageID) {
                currentPresitAnimationFrame = currentPresitAnimationFrame + 1;
                if (currentPresitAnimationFrame >= _this.preSitLoadedImages.length - 1) {
                    deletePresit();
                }
                Entities.editEntity(_this.presitAnimationImageID, { imageURL: 
                        _this.preSitLoadedImages[currentPresitAnimationFrame].url });
            }
        }, PRESIT_FRAME_DURATION);
    }


    // Delete presit local entity in user's screen
    function deletePresit() {
        if (_this.presitAnimationImageID) {
            Entities.deleteEntity(_this.presitAnimationImageID);
            _this.presitAnimationImageID = false;
        }
        if (_this.presitTextID) {
            Entities.deleteEntity(_this.presitTextID);
            _this.presitTextID = false;
        }
        if (_this.presitIntervalID) {
            Script.clearInterval(_this.presitIntervalID);
            _this.presitIntervalID = false;
        }
    }

    // #endregion PRESIT


    // #region HOLD TO STANDUP LOCAL ENTITY

    // Create stand up local entity in user's screen
    var STAND_UP_URL = Script.resolvePath("./resources/images/holdToStandUp.png");
    var STAND_UP_POSITION_IN_FRONT = { x: 0, y: 0, z: -1 };
    var STAND_UP_DIMENSIONS = { x: 0.2, y: 0.2 };
    function createStandUp() {
        if (DEBUG) {
            console.log("creating standup");
        }

        _this.standUpID = Entities.addEntity(
            getEntityPropertiesForImageInFrontOfCamera(
                STAND_UP_POSITION_IN_FRONT,
                STAND_UP_DIMENSIONS,
                STAND_UP_URL
            ),
            "local"
        );
    }


    // Delete local entity in user's screen
    function deleteStandUp() {
        if (_this.standUpID) {
            Entities.deleteEntity(_this.standUpID);
            _this.standUpID = false;
        }
    }

    // #endregion HOLD TO STANDUP


    // #region SITTABLE LOCAL ENTITY

    // Create sittable UI on the chair
    var SITTABLE_START_ALPHA = 0.7;
    var SITTABLE_DIMENSIONS = { x: 0.3, y: 0.3 };
    var SITTABLE_IMAGE_URL_HMD = Script.resolvePath("./resources/images/triggerToSit.png");
    var SITTABLE_IMAGE_URL_DESKTOP = Script.resolvePath("./resources/images/clickToSit.png");
    var SITTABLE_Y_OFFSET = 0.01;
    function createSittableUI() {
        if (_this.sittableID) {
            // already created
            return;
        }

        if (DEBUG) {
            console.log("createSittableUI()");
        }
        var properties = Entities.getEntityProperties(_this.entityID);

        // calculate 
        var localOffset = { x: 0, y: SITTABLE_Y_OFFSET, z: 0 };
        var worldOffset = Vec3.multiplyQbyV(properties.rotation, localOffset);
        var sittablePosition = Vec3.sum(properties.position, worldOffset);

        _this.sittableID = Entities.addEntity({
            type: "Image",
            grab: {
                grabbable: false
            },
            dynamic: false,
            position: sittablePosition,
            rotation: Quat.multiply(
                properties.rotation,
                Quat.fromVec3Degrees({ x: -90, y: 180, z: 0 })
            ),
            parentID: _this.entityID,
            dimensions: SITTABLE_DIMENSIONS,
            imageURL: HMD.active ? SITTABLE_IMAGE_URL_HMD : SITTABLE_IMAGE_URL_DESKTOP,
            ignoreRayIntersection: false,
            alpha: SITTABLE_START_ALPHA,
            script: Script.resolvePath("./resources/sittableUIClient.js") + "?" + Math.random(),
            visible: true,
            emissive: true
        },
        "local"
        );
    }


    // Remove sittable local entity if it exists
    function deleteSittableUI() {
        if (DEBUG) {
            print("deleteSittableUI");
        }

        if (_this.sittableID) {
            Entities.deleteEntity(_this.sittableID);
            _this.sittableID = false;
        }
    }

    // #endregion SITTABLE


    // #region ENTITY LIFETIME FUNCTIONS

    // Check userData for configurable settings
    // If userData is not configured with the right keys update with defaults
    var DEFAULT_SIT_USER_DATA_WITH_CUSTOM_SETTINGS = {
        canClickOnModelToSit: false
    };
    function updateUserData() {
        var properties = Entities.getEntityProperties(_this.entityID);
        try {
            _this.userData = JSON.parse(properties.userData);
        } catch (e) {
            console.log("Issue parsing userData" + e);
        }

        if (!_this.userData || _this.userData.canClickOnModelToSit === undefined) {
            Entities.editEntity(_this.entityID, { userData: JSON.stringify(DEFAULT_SIT_USER_DATA_WITH_CUSTOM_SETTINGS) });
        }
    }


    // Preload entity method
    function preload(id) {
        _this.entityID = id;
        prefetchPresitImages();
        // download sit animation
        AnimationCache.prefetch(ANIMATION_URL);
        updateUserData();
    }


    // Unload entity method
    function unload() {
        deleteSittableUI();
        deletePresit();
        deleteStandUp();
        standUp();

        if (_this.connectedSignals) {
            MyAvatar.scaleChanged.disconnect(_this.standUp);
            MyAvatar.onLoadComplete.disconnect(_this.standUp);
            location.hostChanged.disconnect(_this.standUp);
            Script.scriptEnding.disconnect(_this.standUp);
            MyAvatar.skeletonModelURLChanged.disconnect(_this.standUp);
            MyAvatar.wentAway.disconnect(_this.standUp);
            _this.connectedSignals = false;
        }
    }


    // Called by server script in heartbeat to ensure avatar is still sitting in chair
    function check() {
        Entities.callEntityServerMethod(_this.entityID, "checkResolved");
    }


    // Can sit when clicking on chair when enabled via userData
    function mousePressOnEntity(id, event) {
        if (event.isPrimaryButton && !isInEditMode()) {
            updateUserData();
            if (_this.userData && _this.userData.canClickOnModelToSit) {
                Entities.callEntityServerMethod(_this.entityID, "onSitDown", [MyAvatar.sessionUUID]);
            }
        }
    }

    // #endregion ENTITY LIFETIME FUNCTIONS


    // Constructor
    var _this = null;
    function SitClient() {
        _this = this;
        this.sittableUIID = false;
        this.canSitZoneID = false;

        // for presit local entity and animation
        this.presitIntervalID = false;
        this.presitTextID = false;
        this.presitAnimationImageID = false;

        // for prefetch on presit
        this.preSitLoadedImages = [];
        this.preSitTextLoadedImage = null;

        this.locked = null;

        this.seatCenterPosition = null;
        this.headToHipsDistance = null;
        this.sitDownSettlePeriod = false;

        this.whileSittingUpdateIntervalID = false;

        this.standUpID = false;

        this.driveKeyPressedStart = false;

        this.deviationTimeStart = false;
        this.zoneID = false;

        this.connectedSignals = false;

        // CUSTOMIZATIONS 
        this.userData = {};
        this.canClickOnModelToSit = false;
    }


    // Entity methods
    SitClient.prototype = {
        remotelyCallable: [
            "onEnterCanSitZone",
            "onLeaveCanSitZone",
            "startSitDown",
            "sendRequestToServerScriptToStartSitDown",
            "check"
        ],
        // Zone methods
        onEnterCanSitZone: onEnterCanSitZone,
        onLeaveCanSitZone: onLeaveCanSitZone,
        // Entity liftime methods
        preload: preload,
        unload: unload,
        // Sitting lifetime methods
        sendRequestToServerScriptToStartSitDown: sendRequestToServerScriptToStartSitDown,
        mousePressOnEntity: mousePressOnEntity,
        startSitDown: startSitDown,
        whileSittingUpdate: whileSittingUpdate,
        check: check,
        standUp: standUp
    };


    return new SitClient();
});