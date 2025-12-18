# API Gateway & OpenAPI Specs - Agent Context

## ⚠️ CRITICAL: Documentation Policy

**DO NOT CREATE .MD FILES UNLESS EXPLICITLY REQUESTED BY THE USER**

- ❌ **NEVER** create documentation files for simple questions or explanations
- ❌ **NEVER** create .md files "just in case" or "for future reference"
- ✅ **ALWAYS** provide answers in conversation/chat instead
- ✅ **ONLY** create .md files when the user explicitly asks for documentation

---

## Overview

API Gateway & OpenAPI Specs manages OpenAPI 3.0 specifications for all backend services, generates API client code, and configures the API Gateway routing.

## Purpose

- **OpenAPI Specifications**: Maintain OpenAPI 3.0 specs for all services
- **Code Generation**: Auto-generate API client code from specs
- **API Gateway Configuration**: Configure API Gateway routing
- **Postman Collections**: Generate Postman collections
- **Flutter Client**: Generate Flutter API client code

## Structure

```
api-specs/
├── services/              # Service OpenAPI specs
│   ├── booking-service.yaml
│   ├── user-service.yaml
│   ├── listing-service.yaml
│   └── ... (all services)
├── gateway/              # API Gateway configuration
│   ├── app.yaml          # App API Gateway config
│   ├── dashboard.yaml    # Dashboard API Gateway config
│   └── config.json       # Gateway config
├── libs/flutter/         # Generated Flutter client
└── scripts/              # Code generation scripts
```

## Service Specs

### Location
All service OpenAPI specs are in `services/` directory:
- `booking-service.yaml`
- `user-service.yaml`
- `listing-service.yaml`
- `payment-service.yaml`
- `chat-service.yaml`
- `community-service.yaml`
- `document-service.yaml`
- `review-service.yaml`
- `verification-service.yaml`
- `wishlist-service.yaml`

### Spec Structure
Each spec follows OpenAPI 3.0 format with:
- **Info**: Service metadata
- **Servers**: Service endpoints
- **Paths**: API endpoints
- **Components**: Schemas, security, etc.

## Code Generation

### Flutter Client
- **Location**: `libs/flutter/`
- **Generation**: Auto-generated from OpenAPI specs
- **Usage**: Import in Flutter app for type-safe API calls

### Postman Collections
- **Generation**: Scripts generate Postman collections
- **Purpose**: API testing and documentation

## API Gateway

### Configuration Files
- `gateway/app.yaml`: Main app API Gateway
- `gateway/dashboard.yaml`: Dashboard API Gateway
- `gateway/config.json`: Gateway configuration

### Routing
- Routes requests to appropriate services
- Handles authentication
- Rate limiting
- CORS configuration

## Scripts

### Key Scripts
- `scripts/merge-specs.js`: Merge multiple specs
- `scripts/generate-postman-collections.js`: Generate Postman
- `scripts/convert-all.sh`: Convert all specs
- `scripts/push-to-postman.js`: Push to Postman

## Common Tasks

### Adding New Service Spec
1. Create `services/<service-name>.yaml`
2. Follow OpenAPI 3.0 format
3. Run code generation scripts
4. Update API Gateway config if needed

### Updating Service Spec
1. Edit `services/<service-name>.yaml`
2. Run code generation: `make generate` or `npm run generate`
3. Flutter client auto-updates
4. Test with Postman collection

### Generating Flutter Client
```bash
cd libs/flutter
make generate
# Or
npm run generate:flutter
```

## Important Notes

1. **OpenAPI 3.0**: All specs must follow OpenAPI 3.0 standard
2. **Code Generation**: Client code is auto-generated, don't edit manually
3. **Gateway Config**: API Gateway routes based on these specs
4. **Versioning**: Specs should be versioned with service versions
5. **Validation**: Validate specs before committing

## Integration Points

### Backend Services
- Each service maintains its own OpenAPI spec
- Specs are synced from service repos or maintained here

### Flutter App
- Uses generated Flutter client for API calls
- Type-safe API client from specs

### API Gateway
- Uses specs for routing configuration
- Validates requests against specs

