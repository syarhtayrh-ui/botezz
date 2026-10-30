#!/usr/bin/env bash
# ==============================================================================
# Botezz v5 — Ubuntu 22.04 / 24.04 LTS Live Video Call Streaming Engine Setup
# ==============================================================================
# Provisions:
# 1. FFmpeg & V4L2 utilities (`ffmpeg`, `v4l-utils`, `v4l2loopback-dkms`)
# 2. Virtual Camera Kernel Module (`v4l2loopback` -> `/dev/video0` "WhatsAppVirtualCam")
# 3. PulseAudio Virtual Microphone (`VirtualMic` sink/source)
# 4. Android Debug Bridge (`adb`) & Docker Engine (`docker.io`) for headless
#    Redroid / WhatsApp companion video call bridging.
# ==============================================================================

set -euo pipefail

echo "🚀 [1/4] Updating apt repositories and installing Ubuntu video call dependencies..."
sudo apt-get update -y
sudo apt-get install -y \
  ffmpeg \
  v4l2loopback-dkms \
  v4l2loopback-utils \
  v4l-utils \
  pulseaudio \
  pulseaudio-utils \
  android-tools-adb \
  docker.io \
  linux-modules-extra-"$(uname -r)" || true

echo "📹 [2/4] Loading v4l2loopback virtual camera kernel module on /dev/video0..."
sudo modprobe -r v4l2loopback 2>/dev/null || true
sudo modprobe v4l2loopback \
  devices=1 \
  video_nr=0 \
  card_label="WhatsAppVirtualCam" \
  exclusive_caps=1

if [ -e /dev/video0 ]; then
  sudo chmod 666 /dev/video0
  echo "✅ Virtual Camera device /dev/video0 (WhatsAppVirtualCam) is active!"
  v4l2-ctl --list-devices || true
else
  echo "⚠️ Warning: /dev/video0 was not created. Ensure your kernel headers match uname -r."
fi

echo "🎙️ [3/4] Configuring PulseAudio VirtualMic sink & source..."
pulseaudio --check || pulseaudio -D --exit-idle-time=-1 || true
pactl load-module module-null-sink sink_name=VirtualMicSink sink_properties=device.description=VirtualMicSink 2>/dev/null || true
pactl load-module module-virtual-source source_name=VirtualMic master=VirtualMicSink.monitor source_properties=device.description=VirtualMic 2>/dev/null || true

echo "📱 [4/4] Ready! To launch the headless Android WhatsApp Companion container with /dev/video0 passthrough, run:"
cat << 'EOF'

sudo docker run -itd --rm --privileged \
  --name botezz-whatsapp-cam \
  --device=/dev/video0:/dev/video0 \
  -p 127.0.0.1:5555:5555 \
  redroid/redroid:12.0.0-latest \
  androidboot.redroid_width=720 \
  androidboot.redroid_height=1280 \
  androidboot.redroid_fps=30

adb connect 127.0.0.1:5555
EOF

echo "✅ Ubuntu Live Video Call Engine provisioning complete!"
