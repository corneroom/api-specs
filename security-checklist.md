# Security and Best Practices Checklist

## GitHub Actions Security

### Secrets Management
- [ ] Rotate `OPENAPI_CICD_WORKFLOW_TOKEN` regularly (quarterly)
- [ ] Use least-privilege principle for token permissions
- [ ] Store GCP service account keys in encrypted secrets
- [ ] Implement secret scanning in all repositories

### Workflow Security
```yaml
# Add to all workflows
permissions:
  contents: read        # Only read access by default
  pull-requests: write  # Only when needed for PR operations
  actions: read         # For workflow status checks
```

### Branch Protection
- [ ] Require status checks before merging
- [ ] Require signed commits for production
- [ ] Restrict force pushes to main branch
- [ ] Require admin approval for production deployments

## Environment Protection

### Staging Environment
- [ ] Require passing tests before deployment
- [ ] Auto-cleanup of old deployments (retention policy)
- [ ] Monitoring and alerting setup

### Production Environment  
- [ ] Require manual approval for deployments
- [ ] Implement blue-green deployment strategy
- [ ] Automated rollback on health check failure
- [ ] Change approval workflow integration

## Monitoring & Observability

### Deployment Tracking
```yaml
# Add to all deployment workflows
- name: Track deployment
  run: |
    curl -X POST https://api.monitoring.com/deployments \
      -H "Authorization: Bearer ${{ secrets.MONITORING_TOKEN }}" \
      -d '{
        "service": "api-gateway",
        "environment": "${{ env.ENVIRONMENT }}",
        "version": "${{ github.sha }}",
        "deployed_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
      }'
```

### Alerting
- [ ] Slack notifications for failed deployments
- [ ] Email alerts for production issues
- [ ] PagerDuty integration for critical failures

## Code Quality

### Pre-commit Hooks
```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.4.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-json

  - repo: https://github.com/adrienverge/yamllint
    rev: v1.32.0
    hooks:
      - id: yamllint
```

### OpenAPI Validation
```bash
# Add to package.json scripts
"scripts": {
  "validate-specs": "swagger-codegen validate -i services/*.yaml",
  "lint-specs": "spectral lint services/*.yaml",
  "test-specs": "newman run tests/api-tests.postman_collection.json"
}
```

## Documentation Standards

### Workflow Documentation
- [ ] Document all workflow triggers and purposes
- [ ] Maintain runbook for emergency procedures
- [ ] Keep architecture diagrams up-to-date

### API Documentation
- [ ] Generate OpenAPI docs automatically
- [ ] Include examples in all endpoints
- [ ] Maintain changelog for API versions

## Performance Optimization

### Workflow Performance
- [ ] Use GitHub Actions cache for dependencies
- [ ] Optimize Docker image layers
- [ ] Implement conditional job execution

### API Gateway Performance
- [ ] Configure appropriate rate limiting
- [ ] Implement response caching
- [ ] Monitor gateway metrics

## Compliance & Auditing

### Change Tracking
- [ ] Log all production deployments
- [ ] Track who approved what changes
- [ ] Maintain audit trail for compliance

### Access Control
- [ ] Regular access reviews
- [ ] Principle of least privilege
- [ ] Service account rotation schedule
