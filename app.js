const { createApp } = Vue;

createApp({
  data() {
    return {
      sourceImage: { file: null, preview: null, url: null },
      faceImage: { file: null, preview: null, url: null },
      resultImage: null,
      historyList: [],
      
      safeNoticeAgreed: true,
      isProcessing: false,
      progressPercent: 0,
      progressText: 'Initializing...',

      isDraggingSource: false,
      isDraggingFace: false,

      showSettings: false,
      settings: {
        provider: 'local', // 'local' | 'cloud_replicate' | 'custom_url'
        replicateToken: '',
        customUrl: 'http://127.0.0.1:8000'
      },

      // Sample placeholders for quick testing
      sampleTargets: [
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80',
        'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80'
      ],
      sampleFaces: [
        'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80',
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=400&q=80',
        'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?auto=format&fit=crop&w=400&q=80'
      ]
    };
  },

  computed: {
    canStartSwap() {
      return (
        (this.sourceImage.preview || this.sourceImage.url) &&
        (this.faceImage.preview || this.faceImage.url) &&
        this.safeNoticeAgreed
      );
    },
    backendBaseUrl() {
      if (this.settings.provider === 'local') return 'http://127.0.0.1:8000';
      if (this.settings.provider === 'custom_url') return this.settings.customUrl.replace(/\/+$/, '');
      return '';
    }
  },

  mounted() {
    // Prevent browser from navigating away if file is dropped outside dropzone
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Load local history & settings
    const savedHistory = localStorage.getItem('faceswap_history');
    if (savedHistory) {
      try { this.historyList = JSON.parse(savedHistory); } catch (e) {}
    }
    const savedSettings = localStorage.getItem('faceswap_settings');
    if (savedSettings) {
      try { this.settings = { ...this.settings, ...JSON.parse(savedSettings) }; } catch (e) {}
    }
  },

  methods: {
    triggerInput(refName) {
      this.$refs[refName].click();
    },

    handleFileChange(event, type) {
      const file = event.target.files[0];
      if (file) {
        this.processFile(file, type);
      }
    },

    handleDrop(event, type) {
      if (type === 'source') {
        this.isDraggingSource = false;
      } else {
        this.isDraggingFace = false;
      }

      const files = event.dataTransfer.files;
      if (files && files.length > 0) {
        this.processFile(files[0], type);
      }
    },

    processFile(file, type) {
      if (!file.type.startsWith('image/')) {
        Swal.fire('Invalid File', 'Please select a valid image file (JPG, PNG, WEBP)', 'error');
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        if (type === 'source') {
          this.sourceImage = { file, preview: e.target.result, url: null };
        } else {
          this.faceImage = { file, preview: e.target.result, url: null };
        }
      };
      reader.readAsDataURL(file);
    },

    selectTemplate(url, type) {
      if (type === 'source') {
        this.sourceImage = { file: null, preview: url, url: url };
      } else {
        this.faceImage = { file: null, preview: url, url: url };
      }
    },

    clearImage(type) {
      if (type === 'source') {
        this.sourceImage = { file: null, preview: null, url: null };
        if (this.$refs.sourceInput) this.$refs.sourceInput.value = '';
      } else {
        this.faceImage = { file: null, preview: null, url: null };
        if (this.$refs.faceInput) this.$refs.faceInput.value = '';
      }
    },

    saveSettings() {
      localStorage.setItem('faceswap_settings', JSON.stringify(this.settings));
      this.showSettings = false;
      Swal.fire({
        icon: 'success',
        title: 'Settings Saved',
        timer: 1500,
        showConfirmButton: false
      });
    },

    async startFaceSwap() {
      if (!this.safeNoticeAgreed) {
        Swal.fire('Policy Required', 'Please accept the Responsible AI Use policy.', 'warning');
        return;
      }

      if (!this.canStartSwap) {
        Swal.fire('Photos Missing', 'Please upload both target and face images.', 'warning');
        return;
      }

      this.isProcessing = true;
      this.progressPercent = 10;
      this.progressText = 'Uploading images...';

      try {
        if (this.settings.provider === 'cloud_replicate') {
          await this.processWithReplicate();
        } else {
          await this.processWithCustomBackend();
        }
      } catch (err) {
        console.error(err);
        Swal.fire({
          icon: 'error',
          title: 'Swap Failed',
          text: err.message || 'An error occurred while communicating with the backend.'
        });
        this.isProcessing = false;
      }
    },

    // Process via local or custom FastAPI backend (same endpoints as aifaceswap.io)
    async processWithCustomBackend() {
      const baseUrl = this.backendBaseUrl;
      this.progressPercent = 25;
      this.progressText = 'Submitting task to queue...';

      // 1. Submit task
      const payload = {
        target_image: this.sourceImage.preview,
        face_image: this.faceImage.preview
      };

      const res = await fetch(`${baseUrl}/api/generate_face_v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.detail || `Server returned ${res.status}`);
      }

      const initData = await res.json();
      const taskId = initData.data.task_id;

      // 2. Poll for status
      this.progressPercent = 40;
      this.progressText = 'AI is processing face alignment & swap...';
      await this.pollStatus(baseUrl, taskId);
    },

    async pollStatus(baseUrl, taskId) {
      let done = false;
      let attempts = 0;

      while (!done && attempts < 60) {
        attempts++;
        await new Promise((r) => setTimeout(r, 2000));

        const res = await fetch(`${baseUrl}/api/check_status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: taskId })
        });

        if (!res.ok) continue;

        const data = await res.json();
        const status = data.data.status;

        if (status === 0) {
          this.progressPercent = 45;
          this.progressText = 'In GPU Queue...';
        } else if (status === 1) {
          this.progressPercent = Math.min(90, this.progressPercent + 15);
          this.progressText = 'AI model swapping and restoring face...';
        } else if (status === 2) {
          // Success
          this.progressPercent = 100;
          this.onSwapSuccess(data.data.result_image);
          done = true;
          return;
        } else if (status === 3 || status === -1) {
          throw new Error('Face swapping model failed to detect or swap the face.');
        }
      }

      if (!done) {
        throw new Error('Task timed out in queue.');
      }
    },

    // Process directly via Replicate Cloud API (if user chooses serverless mode)
    async processWithReplicate() {
      if (!this.settings.replicateToken) {
        this.showSettings = true;
        throw new Error('Please enter your Replicate API Token in settings.');
      }

      this.progressPercent = 30;
      this.progressText = 'Calling Replicate AI model...';

      // Example using lucataco/faceswap or cdm/face-swap
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.settings.replicateToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'wait'
        },
        body: JSON.stringify({
          version: "c2d78d10e501d3f0f873b2ceb82438161e3043a053e003d2112e61d67497460c",
          input: {
            target_image: this.sourceImage.preview,
            swap_image: this.faceImage.preview
          }
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to call Replicate API.');
      }

      const pred = await res.json();
      if (pred.output) {
        this.onSwapSuccess(pred.output);
      } else {
        throw new Error('Replicate did not return an output.');
      }
    },

    onSwapSuccess(resultUrl) {
      this.resultImage = resultUrl;
      this.isProcessing = false;

      // Add to history
      this.historyList.unshift(resultUrl);
      if (this.historyList.length > 8) this.historyList.pop();
      localStorage.setItem('faceswap_history', JSON.stringify(this.historyList));

      Swal.fire({
        icon: 'success',
        title: 'Swap Success!',
        timer: 2000,
        showConfirmButton: false
      });

      // Scroll to result
      this.$nextTick(() => {
        window.scrollBy({ top: 400, behavior: 'smooth' });
      });
    },

    downloadResult() {
      if (!this.resultImage) return;

      // Convert to JPG download
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        canvas.toBlob((blob) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `faceswap_${Date.now()}.jpg`;
          a.click();
          URL.revokeObjectURL(url);
        }, 'image/jpeg', 0.95);
      };
      img.src = this.resultImage;
    },

    shareResult() {
      if (navigator.share) {
        navigator.share({
          title: 'My AI Face Swap',
          url: window.location.href
        }).catch(() => {});
      } else {
        navigator.clipboard.writeText(window.location.href);
        Swal.fire('Link Copied', 'Page URL copied to clipboard!', 'info');
      }
    },

    clearHistory() {
      this.historyList = [];
      localStorage.removeItem('faceswap_history');
    }
  }
}).mount('#app');
