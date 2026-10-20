-- SAML 2.0 single sign-on: new provider kind and user source.
ALTER TABLE auth_providers MODIFY kind ENUM('oidc','ldap','saml') NOT NULL;
ALTER TABLE users MODIFY auth_source ENUM('local','oidc','ldap','saml') NOT NULL DEFAULT 'local';
