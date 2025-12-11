# SDK Generation & Release Workflow Guide

## 🎯 Overview

This guide covers the enhanced SDK generation system that automatically creates Flutter/Dart and React/TypeScript SDKs from OpenAPI specifications with support for both production releases and development snapshots.

## 🔄 Release Types

### Production Releases (`v*` tags)
- **Trigger**: Push git tags (e.g., `v1.0.0`, `v2.1.0`)
- **Environment**: Production
- **SDK Reference**: Tag name (e.g., `v1.0.0`)
- **GitHub Release**: Full release
- **Use Case**: Stable versions for production applications

### Development Snapshots (main branch)
- **Trigger**: Push to `main` branch
- **Environment**: Staging  
- **SDK Reference**: `snapshot-dev-YYYYMMDD-HHMMSS-{commit}`
- **GitHub Release**: Pre-release with warning
- **Use Case**: Ongoing development and testing

### Manual Releases (workflow_dispatch)
- **Trigger**: Manual workflow execution
- **Environment**: Configurable (staging/production)
- **SDK Reference**: Various formats based on options
- **GitHub Release**: Based on configuration
- **Use Case**: Testing, emergency releases, custom scenarios

## 📦 SDK Types & Configuration

The system reads configuration from `gateway/config.json`:

```json
{
  "sdkSettings": {
    "repositoryUrl": "https://github.com/inspiredtechinc/sdk.git",
    "generators": {
      "dart": {"generator": "dart"},
      "typescript": {"generator": "typescript-fetch"}
    },
    "outputPaths": {
      "dart": "openapi-dart-sdk",
      "typescript": "openapi-typescript-sdk"
    }
  },
  "gateways": {
    "app": {
      "sdkConfig": {
        "enabled": true,
        "targets": ["dart"],
        "platforms": ["Flutter", "Dart"],
        "description": "Mobile app SDK for Flutter/Dart applications"
      }
    },
    "dashboard": {
      "sdkConfig": {
        "enabled": true,
        "targets": ["typescript"],
        "platforms": ["React", "TypeScript"],
        "description": "Dashboard SDK for React/TypeScript applications"
      }
    }
  }
}
```

## 🚀 Usage Instructions

### Flutter/Dart SDK Usage

#### Production (Recommended)
```yaml
# pubspec.yaml
dependencies:
  app_sdk:
    git:
      url: https://github.com/inspiredtechinc/sdk.git
      path: openapi-dart-sdk/app
      ref: v1.0.0  # Use latest stable tag
```

#### Development Snapshots
```yaml
# pubspec.yaml
dependencies:
  app_sdk:
    git:
      url: https://github.com/inspiredtechinc/sdk.git
      path: openapi-dart-sdk/app
      ref: snapshot-dev-20240723-143022-abc1234  # Latest dev snapshot
```

### React/TypeScript SDK Usage

#### Production (Recommended)
```bash
npm install github:inspiredtechinc/sdk#v1.0.0:openapi-typescript-sdk/dashboard
```

#### Development Snapshots
```bash
npm install github:inspiredtechinc/sdk#snapshot-dev-20240723-143022-abc1234:openapi-typescript-sdk/dashboard
```

## 🔧 Workflow Triggers

### 1. Automatic Triggers

```bash
# Production release
git tag v1.2.0
git push origin v1.2.0

# Development snapshot
git push origin main  # Automatically creates snapshot
```

### 2. Manual Triggers

Via GitHub Actions UI or GitHub CLI:

```bash
# Manual staging release
gh workflow run "Generate and Release SDKs" \
  -f environment=staging \
  -f snapshot_type=staging-snapshot

# Manual development snapshot
gh workflow run "Generate and Release SDKs" \
  -f environment=staging \
  -f snapshot_type=dev-snapshot

# Force release (even without changes)
gh workflow run "Generate and Release SDKs" \
  -f environment=staging \
  -f force_release=true
```

## 📋 Release Naming Convention

| Release Type | Format | Example |
|-------------|---------|---------|
| Production Tag | `v{major}.{minor}.{patch}` | `v1.2.0` |
| Dev Snapshot | `snapshot-dev-{date}-{time}-{commit}` | `snapshot-dev-20240723-143022-abc1234` |
| Staging Snapshot | `v{date}-staging-{time}` | `v2024.07.23-staging-1430` |
| Manual Production | `v{date}-manual-prod` | `v2024.07.23-manual-prod` |

## 🎯 Best Practices

### For Developers

1. **Use Production Releases** for stable applications
2. **Use Development Snapshots** for active development and testing
3. **Pin Specific Versions** in your dependencies
4. **Monitor Pre-release Warnings** in snapshot releases

### For Release Management

1. **Tag Releases** follow semantic versioning (`v1.0.0`, `v1.1.0`, etc.)
2. **Test Snapshots** before creating production releases
3. **Document Breaking Changes** in release notes
4. **Coordinate Releases** with frontend teams

## 🔍 Monitoring & Debugging

### GitHub Actions
- Monitor workflow runs: https://github.com/inspiredtechinc/api-specs/actions
- Check step summaries for SDK generation details
- Review error logs for troubleshooting

### SDK Repository
- Browse releases: https://github.com/inspiredtechinc/sdk/releases
- Check pre-release flags for development versions
- Verify SDK structure and content

### Slack Notifications
- Production releases: Green notifications
- Development snapshots: Orange notifications
- Failed releases: Red notifications

## 🔧 Adding New Gateways

To add support for future gateways (e.g., `future-gw1`):

1. **Update `gateway/config.json`**:
```json
{
  "gateways": {
    "future-gw1": {
      "sdkConfig": {
        "enabled": true,
        "targets": ["typescript"],
        "platforms": ["React", "TypeScript"],
        "description": "Future gateway SDK for specialized applications"
      }
    }
  }
}
```

2. **Create Gateway Spec**: Add `gateway/future-gw1.yaml`

3. **Test**: Run `npm run gateway` to validate

The SDK workflow will automatically detect and generate SDKs for the new gateway!

## 🐛 Troubleshooting

### Common Issues

1. **No SDKs Generated**
   - Check `sdkConfig.enabled: true` in config.json
   - Verify gateway YAML files exist
   - Review workflow logs for errors

2. **SDK Generation Fails**
   - Check OpenAPI spec validity: `npm run validate`
   - Verify generator compatibility
   - Review OpenAPI Generator CLI logs

3. **GitHub Release Fails**
   - Check `SDK_PUSH_TOKEN` permissions
   - Verify repository access
   - Check branch/tag naming conventions

### Debug Commands

```bash
# Validate all specs
npm run validate

# Generate gateway specs locally
npm run gateway

# Test SDK generation locally
npx @openapitools/openapi-generator-cli generate \
  -i gateway/app.yaml \
  -g dart \
  -o test-output/dart-sdk
```

## 📈 Metrics & Analytics

The workflow provides comprehensive logging:

- **Generation Time**: Track SDK build duration
- **Success Rate**: Monitor workflow success/failure
- **Usage Patterns**: Analyze which SDKs are most used
- **Release Frequency**: Track development vs production releases

## 🔒 Security Considerations

- **Token Management**: `SDK_PUSH_TOKEN` requires minimal necessary permissions
- **Branch Protection**: Production releases require tag protection
- **Access Control**: Limit manual workflow dispatch to authorized users
- **Dependency Scanning**: Monitor generated SDKs for vulnerabilities

---

## 📞 Support

For issues with SDK generation:
1. Check this guide first
2. Review GitHub Actions logs
3. Contact the API team via Slack
4. Create an issue in the api-specs repository

**Happy SDK Development!** 🚀
