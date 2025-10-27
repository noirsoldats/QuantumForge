# Application Icons and Branding Assets

This directory contains the icons and branding assets used for building installers.

## Required Assets

### Application Icons

#### Mac Icon (icon.icns)
- **File**: `icon.icns`
- **Format**: Apple Icon Image format
- **Required Sizes**: 16x16, 32x32, 64x64, 128x128, 256x256, 512x512, 1024x1024
- **How to Create**:
  1. Start with a 1024x1024 PNG file
  2. Use an icon generator tool or command line:
     ```bash
     # Create iconset directory
     mkdir icon.iconset

     # Resize source image to all required sizes
     sips -z 16 16     icon-1024.png --out icon.iconset/icon_16x16.png
     sips -z 32 32     icon-1024.png --out icon.iconset/icon_16x16@2x.png
     sips -z 32 32     icon-1024.png --out icon.iconset/icon_32x32.png
     sips -z 64 64     icon-1024.png --out icon.iconset/icon_32x32@2x.png
     sips -z 128 128   icon-1024.png --out icon.iconset/icon_128x128.png
     sips -z 256 256   icon-1024.png --out icon.iconset/icon_128x128@2x.png
     sips -z 256 256   icon-1024.png --out icon.iconset/icon_256x256.png
     sips -z 512 512   icon-1024.png --out icon.iconset/icon_256x256@2x.png
     sips -z 512 512   icon-1024.png --out icon.iconset/icon_512x512.png
     sips -z 1024 1024 icon-1024.png --out icon.iconset/icon_512x512@2x.png

     # Convert to .icns
     iconutil -c icns icon.iconset
     ```

#### Windows Icon (icon.ico)
- **File**: `icon.ico`
- **Format**: Windows Icon format
- **Required Sizes**: 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256
- **How to Create**: Use an online converter or tools like ImageMagick
  ```bash
  convert icon-256.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
  ```

### Installer Branding (Optional but Recommended)

#### Mac DMG Background
- **File**: `background.png` or `background@2x.png`
- **Size**: 540x380 (1x) or 1080x760 (2x)
- **Usage**: Background image for DMG installer window
- **Design Tips**:
  - Include visual guide showing drag to Applications folder
  - Use brand colors and logo
  - Keep it clean and professional

#### Windows NSIS Installer Images

**Installer Header:**
- **File**: `installerHeader.png`
- **Size**: 150x57 pixels
- **Format**: PNG
- **Usage**: Top banner in Windows installer

**Installer Sidebar:**
- **File**: `installerSidebar.png`
- **Size**: 164x314 pixels
- **Format**: PNG
- **Usage**: Left sidebar in Windows installer

## Current Status

⚠️ **Placeholder icons are currently in use.** The application will build with default Electron icons until custom icons are added to this directory.

To add custom icons:
1. Create your icon design (1024x1024 PNG recommended as source)
2. Generate .icns and .ico files using the instructions above
3. Place them in this directory
4. Optionally add installer branding images
5. Rebuild the application

## Testing Icons

After adding icons, rebuild the app to see them:
```bash
npm run build:mac    # For Mac
npm run build:win    # For Windows
```

The icons will appear:
- In the application dock/taskbar
- In the title bar
- In the installer
- In the system applications folder
