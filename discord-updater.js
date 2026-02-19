

class DiscordProfileUpdater {
  constructor(workerUrl) {
    this.workerUrl = workerUrl;
    this.updateInterval = 60 * 60 * 1000; // 1 hour (since KV updates daily)
    this.lastUpdate = null;
    this.isUpdating = false;
  }

  
  async init() {
    console.log('🔄 Discord Profile Updater started');
    

    await this.updateProfile();
    

    setInterval(() => {
      this.updateProfile();
    }, this.updateInterval);
    

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.shouldUpdate()) {
        this.updateProfile();
      }
    });
  }

  
  shouldUpdate() {
    if (!this.lastUpdate) return true;
    const timeSinceUpdate = Date.now() - this.lastUpdate;
    return timeSinceUpdate > 30 * 60 * 1000; // At least 30 minutes apart
  }

  
  async fetchDiscordProfile() {
    try {
      const response = await fetch(`${this.workerUrl}/api/discord-profile`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('❌ Failed to fetch Discord profile:', error);
      throw error;
    }
  }

  
  async updateProfile() {
    if (this.isUpdating) {
      console.log('⏳ Update already in progress, skipping...');
      return;
    }

    this.isUpdating = true;
    
    try {
      console.log('🔄 Fetching Discord profile data...');
      const profileData = await this.fetchDiscordProfile();
      
      if (!profileData || profileData.error) {
        throw new Error(profileData?.message || 'Invalid profile data received');
      }

      this.updateProfilePicture(profileData.avatar);
      

      if (profileData.banner) {
        this.updateBanner(profileData.banner);
      }
      

      this.updateUsername(profileData.globalName || profileData.username);
      
      this.lastUpdate = Date.now();
      console.log('✅ Profile updated successfully:', {
        username: profileData.globalName || profileData.username,
        avatar: profileData.avatar ? 'Updated' : 'Default',
        banner: profileData.banner ? 'Updated' : 'None',
        timestamp: new Date(profileData.lastUpdated).toLocaleString()
      });

    } catch (error) {
      console.error('❌ Failed to update profile:', error);
    } finally {
      this.isUpdating = false;
    }
  }

  
  updateProfilePicture(avatarUrl) {
    const profileImg = document.querySelector('.profile-pic img');
    const ogImage = document.querySelector('meta[property="og:image"]');
    

    const workerImageUrl = `${this.workerUrl}/pfp/image.png`;
    
    if (profileImg) {
      profileImg.src = workerImageUrl;
      profileImg.alt = 'Discord Avatar';
      console.log('🖼️ Profile picture updated to use cached image');
    } else {
      console.log('❌ Profile picture element not found');
    }
    
    if (ogImage) {
      ogImage.content = workerImageUrl;
    }
  }

  
  updateBanner(bannerUrl) {
    const bannerBg = document.querySelector('.profile-ban-bg');
    

    const workerBannerUrl = `${this.workerUrl}/banner/image.png`;
    
    if (bannerBg) {

      bannerBg.style.background = `url('${workerBannerUrl}') no-repeat center center`;
      bannerBg.style.backgroundSize = 'cover';
      console.log('🎨 Banner updated to use cached image');
    } else {
      console.log('❌ Banner element not found');
    }
  }

  
  updateUsername(username) {

    const usernameElement = document.querySelector('h1#username-typewriter');
    if (usernameElement && username) {

      usernameElement.textContent = `@${username.toLowerCase()}`;
    }
  }

  
  async forceUpdate() {
    this.isUpdating = false; // Reset the flag
    await this.updateProfile();
  }
}

document.addEventListener('DOMContentLoaded', () => {

  const WORKER_URL = 'https://profileapi.contentltd.xyz';
  
  const updater = new DiscordProfileUpdater(WORKER_URL);
  updater.init();
  

  window.discordUpdater = updater;
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DiscordProfileUpdater;
}