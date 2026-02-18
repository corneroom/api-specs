# OpenAPI Documentation Hub

A centralized system for managing, validating, converting, and publishing OpenAPI documentation for microservices.

> **⚠️ Do not manually edit generated specs**: The files in `gateway/` (e.g. `app.yaml`, `app-swagger.yaml`) and `services/` are generated or synced from backend service `docs/api.yaml` files. To add or change API endpoints, edit the source spec in the backend service (e.g. `backend/user-service/docs/api.yaml`), then run `make sync` and `make build-swagger` (or `make gateway`) from this directory.

## Project Overview

This repository serves as a central hub for OpenAPI/Swagger specifications across multiple microservices. It provides:

1. **Centralized Storage**: Store all service API specifications in one place
2. **Flexible Gateway Configuration**: Configure multiple API gateways using a simple JSON configuration
3. **Validation & Conversion**: Automatic validation and conversion between OpenAPI 3.x and Swagger 2.0
4. **Documentation Generation**: Create beautiful API documentation using Swagger UI and ReDoc
5. **Deployment Automation**: GitHub Actions integration with Google Cloud API Gateway

## Directory Structure

```
├── services/             # Individual service specifications
│   ├── user-service.v1.yaml
│   ├── order-service.v1.yaml
│   └── product-service.v1.yaml
├── gateway/              # Gateway configurations and generated specs
│   ├── config.json       # Gateway configuration file
│   ├── app.yaml          # Generated app gateway spec (OpenAPI 3.0)
│   ├── app-swagger.yaml  # Generated app gateway spec (OpenAPI 2.0 for GCP)
│   ├── dashboard.yaml    # Generated dashboard gateway spec (OpenAPI 3.0)
│   └── dashboard-swagger.yaml  # Generated dashboard gateway spec (OpenAPI 2.0 for GCP)
├── scripts/              # Automation scripts
│   ├── merge-specs.js    # Merge and convert specs
│   ├── convert-specs.js  # Convert OpenAPI 3.0 to Swagger 2.0
│   └── validate-services.js  # Validate service specs
├── .github/workflows/    # GitHub Actions workflows
│   ├── staging.yml       # Deploy to staging environment
│   ├── prod.yml          # Deploy to production environment
│   └── cleanup.yml       # Clean up unused API configs
└── package.json          # Dependencies and scripts
```

## Gateway Configuration

The `gateway/config.json` file controls which service specs are included in each gateway:

```json
{
  "apiName": "corneroom-api",
  "gateways": {
    "app": {
      "name": "App API Gateway",
      "description": "API Gateway for client-facing application endpoints",
      "version": "1.0.0",
      "hosts": [
        { "url": "https://app-staging-gateway.example.com/api/v1", "description": "Staging" },
        { "url": "https://app-prod-gateway.example.com/api/v1", "description": "Production" }
      ],
      "basePath": "/api/v1",
      "services": [
        "user-service.v1",
        "order-service.v1"
      ]
    },
    "dashboard": {
      "name": "Dashboard API Gateway",
      "description": "API Gateway for admin dashboard endpoints",
      "version": "1.0.0",
      "hosts": [
        { "url": "https://dashboard-staging-gateway.example.com/api/v1", "description": "Staging" },
        { "url": "https://dashboard-prod-gateway.example.com/api/v1", "description": "Production" }
      ],
      "basePath": "/api/v1",
      "services": [
        "product-service.v1",
        "user-service.v1"
      ]
    }
  }
}
```

You can add, remove, or modify gateways in this file to control which services are exposed through each gateway.

## OpenAPI Versions and GCP API Gateway

Google Cloud Platform's API Gateway requires OpenAPI/Swagger 2.0 format for deployment. This repository is set up to:

1. Generate and maintain gateway specs in OpenAPI 3.0 format for documentation
2. Automatically convert specs to OpenAPI/Swagger 2.0 format for GCP deployment
3. Deploy the converted Swagger 2.0 specs to GCP API Gateway

The conversion happens automatically when you run:
```bash
npm run gateway
```

Or you can manually convert existing OpenAPI 3.0 specs:
```bash
npm run convert
```

## Setting Up

### Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- Access to GitHub and Google Cloud Platform

### Installation

1. Clone this repository
   ```bash
   git clone https://github.com/your-org/api-specs.git
   cd api-specs
   ```

2. Install dependencies
   ```bash
   npm install
   ```

### Local Development

To generate gateway specs (creates both OpenAPI 3.0 and 2.0 versions):

```bash
npm run gateway
```

To convert existing OpenAPI 3.0 specs to Swagger 2.0:

```bash
npm run convert
```

You can also convert a specific file:
```bash
npm run convert -- --file=gateway/app.yaml
```

To clean generated files:

```bash
npm run clean
```

To generate documentation locally:

```bash
npm run generate-docs
```

To run a local documentation server:

```bash
npm run serve-docs
```

Then visit http://localhost:3000 to view the documentation.

## GitHub Actions Setup

### Required Secrets

For the `api-specs` repository:

- `GCP_PROJECT_ID`: Google Cloud Project ID
- `GCP_WORKLOAD_IDENTITY_PROVIDER`: Google Cloud Workload Identity Provider
- `GCP_SERVICE_ACCOUNT`: Google Cloud Service Account email
- `GCP_BACKEND_AUTH_SERVICE_ACCOUNT`: Service account for API Gateway backend authentication
- `API_DOCS_REPO_PAT`: GitHub Personal Access Token for triggering docs repository
- `API_DOCS_REPO`: Repository name in format "owner/repo" for the docs repository

For the `api-docs` repository:

- `API_SPECS_REPO_PAT`: GitHub PAT to access the `api-specs` repository

## Workflow Integration

### Adding a New Microservice

1. Add your OpenAPI/Swagger specification to the `services/` directory
2. Follow the naming convention: `{service-name}.v{version}.yaml`
3. Update the `gateway/config.json` file to include the service in the desired gateways
4. Push your changes to trigger the validation workflow
5. The spec will be automatically validated, merged, and deployed to the appropriate gateways

### Adding a New Gateway

1. Add a new gateway entry to the `gateway/config.json` file
2. Specify which services should be included in the gateway
3. Push your changes to trigger the validation workflow
4. The new gateway will be automatically created and deployed

### Deployment Flow

- Deploy to staging: Manually trigger the staging workflow or via repository_dispatch
- Deploy to production: Manually trigger the production workflow or via repository_dispatch

## Documentation

Generated documentation is available at:
- Staging: https://your-org.github.io/api-docs/staging/
- Production: https://your-org.github.io/api-docs/

## Contributing

1. Create a new branch for your changes
2. Add or modify API specifications in the `services/` directory
3. Create a Pull Request to the `develop` branch
4. Once approved and merged, the changes will be deployed to staging

## License

This project is licensed under the MIT License - see the LICENSE file for details.
